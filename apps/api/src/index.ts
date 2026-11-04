import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import { copyFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_NAME } from '@eview-clips/core';
import {
  buildYoutubeAuthUrl,
  exchangeCodeAndPersistTokens,
  getYoutubeConnectionStatus,
} from './youtube-auth.js';
import { listRecordingSummaries } from './recordings.js';
import { listConnectedChannelLives } from './youtube-lives.js';
import { importYoutubeVideoToInbox } from './youtube-import.js';

const app = Fastify({ logger: true });

const resolveDataDir = () => {
  const configured = process.env.DATA_DIR || './data';
  if (path.isAbsolute(configured)) {
    return configured;
  }

  const cwd = process.cwd();
  if (path.basename(path.dirname(cwd)) === 'apps') {
    return path.resolve(cwd, '..', '..', configured);
  }

  return path.resolve(cwd, configured);
};

const mediaRoot = path.join(resolveDataDir(), 'media');
const inboxRoot = path.join(mediaRoot, 'inbox');

const detectMimeType = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
};

type ImportJobStatus = 'running' | 'completed' | 'failed';
type ImportJob = {
  id: string;
  videoId: string;
  title?: string;
  fileName?: string;
  transcriptFileName?: string | null;
  status: ImportJobStatus;
  stage?: string;
  progressPercent: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
const importJobs = new Map<string, ImportJob>();

app.get('/health', async () => ({ ok: true, app: APP_NAME, timestamp: new Date().toISOString() }));

app.get('/api/health', async () => ({ ok: true, app: APP_NAME, timestamp: new Date().toISOString() }));

app.get('/api/recordings', async (request, reply) => {
  try {
    const data = await listRecordingSummaries();
    return { data };
  } catch (error) {
    request.log.error({ error }, 'Falha ao listar recordings reais do disco');
    return reply.status(500).send({
      error: 'recordings_list_failed',
      message: 'Falha ao listar os recordings em data/media/recordings.',
    });
  }
});

app.post('/api/youtube/lives/:videoId/import', async (request, reply) => {
  const { videoId } = request.params as { videoId: string };
  if (!videoId) {
    return reply.status(400).send({
      error: 'missing_video_id',
      message: 'videoId é obrigatório.',
    });
  }

  const existing = importJobs.get(videoId);
  if (existing?.status === 'running') {
    return reply.status(409).send({
      error: 'import_already_running',
      message: 'Já existe uma importação em andamento para essa live.',
      job: existing,
    });
  }

  const jobId = `${videoId}-${Date.now()}`;
  const createdAt = new Date().toISOString();
  const job: ImportJob = {
    id: jobId,
    videoId,
    status: 'running',
    stage: 'queued',
    progressPercent: 0,
    createdAt,
    updatedAt: createdAt,
  };
  importJobs.set(videoId, job);

  void (async () => {
    try {
      const result = await importYoutubeVideoToInbox(videoId, inboxRoot, (percent, stage) => {
        const current = importJobs.get(videoId);
        if (!current) {
          return;
        }
        importJobs.set(videoId, {
          ...current,
          stage,
          progressPercent: percent,
          updatedAt: new Date().toISOString(),
        });
      });
      const updatedAt = new Date().toISOString();
      importJobs.set(videoId, {
        ...job,
        status: 'completed',
        stage: 'completed',
        progressPercent: 100,
        title: result.title,
        fileName: result.fileName,
        transcriptFileName: result.transcriptFileName,
        updatedAt,
      });
    } catch (error) {
      request.log.error({ error, videoId }, 'Falha ao importar live do YouTube para inbox');
      importJobs.set(videoId, {
        ...job,
        status: 'failed',
        stage: 'failed',
        progressPercent: 0,
        error: error instanceof Error ? error.message : 'Falha desconhecida na importação.',
        updatedAt: new Date().toISOString(),
      });
    }
  })();

  return reply.status(202).send({
    ok: true,
    message: 'Importação iniciada. O worker vai planejar os cortes e mostrar o tempo exato do vídeo original.',
    job,
  });
});

app.get('/api/youtube/import-jobs', async () => ({
  data: Array.from(importJobs.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
}));

const renderClipToFile = async (
  sourcePath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number,
) => {
  const { spawn } = await import('node:child_process');
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-y',
      '-ss',
      String(startSeconds),
      '-i',
      sourcePath,
      '-t',
      String(durationSeconds),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      outputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr || 'unknown error'}`));
      }
    });
  });
};

app.post('/api/recordings/:recordingId/render-clip', async (request, reply) => {
  const { recordingId } = request.params as { recordingId: string };
  const body = (request.body ?? {}) as {
    kind?: 'episodes' | 'shorts';
    clipId?: string;
    start?: number;
    duration?: number;
  };
  const kind = body.kind ?? 'episodes';
  const clipId = body.clipId ?? null;
  const startSeconds = Number(body.start ?? 0);
  const durationSeconds = Number(body.duration ?? 0);

  if (!recordingId || !clipId) {
    return reply.status(400).send({
      error: 'missing_clip_data',
      message: 'recordingId e clipId são obrigatórios.',
    });
  }

  if (!['episodes', 'shorts'].includes(kind)) {
    return reply.status(400).send({
      error: 'invalid_kind',
      message: 'kind deve ser episodes ou shorts.',
    });
  }

  const recordingsRoot = path.join(mediaRoot, 'recordings');
  const recordingDir = path.join(recordingsRoot, recordingId);
  const sourceEntry = (await readdir(recordingDir, { withFileTypes: true })).find(
    (entry) => entry.isFile() && entry.name.startsWith('source.'),
  );
  if (!sourceEntry) {
    return reply.status(404).send({
      error: 'source_not_found',
      message: 'Arquivo de origem da gravação não encontrado.',
    });
  }

  const sourcePath = path.join(recordingDir, sourceEntry.name);
  const renderDir = path.join(mediaRoot, 'renders', recordingId, kind);
  const outputPath = path.join(renderDir, `${clipId}.mp4`);

  if (!Number.isFinite(startSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return reply.status(400).send({
      error: 'invalid_clip_window',
      message: 'start e duration do corte devem ser válidos.',
    });
  }

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(renderDir, { recursive: true }));
    await renderClipToFile(sourcePath, outputPath, startSeconds, durationSeconds);
    return {
      ok: true,
      message: 'Corte renderizado em modo manual.',
      clipId,
      kind,
      outputPath: path.posix.join('renders', recordingId, kind, `${clipId}.mp4`),
    };
  } catch (error) {
    request.log.error({ error, recordingId, clipId, kind }, 'Falha ao renderizar corte manual');
    return reply.status(500).send({
      error: 'clip_render_failed',
      message: 'Falha ao renderizar o corte selecionado.',
    });
  }
});

app.post('/api/recordings/:recordingId/regenerate', async (request, reply) => {
  const { recordingId } = request.params as { recordingId: string };
  const body = (request.body ?? {}) as { mode?: 'all' | 'shorts' | 'episodes'; resetRender?: boolean };
  const mode = body.mode ?? 'all';
  const resetRender = body.resetRender ?? true;

  if (!recordingId) {
    return reply.status(400).send({
      error: 'missing_recording_id',
      message: 'recordingId é obrigatório.',
    });
  }

  if (!['all', 'shorts', 'episodes'].includes(mode)) {
    return reply.status(400).send({
      error: 'invalid_mode',
      message: 'Modo inválido. Use all, shorts ou episodes.',
    });
  }

  const recordingsRoot = path.join(mediaRoot, 'recordings');
  const recordingDir = path.join(recordingsRoot, recordingId);
  try {
    const dirEntries = await readdir(recordingDir, { withFileTypes: true });
    const sourceEntry = dirEntries.find((entry) => entry.isFile() && entry.name.startsWith('source.'));
    if (!sourceEntry) {
      return reply.status(404).send({
        error: 'source_not_found',
        message: 'Arquivo de origem da gravação não encontrado.',
      });
    }

    if (resetRender) {
      const renderRoot = path.join(mediaRoot, 'renders', recordingId);
      await rm(renderRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(path.join(recordingDir, 'segments.json'), { force: true }).catch(() => undefined);
      await rm(path.join(recordingDir, 'status.json'), { force: true }).catch(() => undefined);
    }

    const sourcePath = path.join(recordingDir, sourceEntry.name);
    const destName = `${recordingId}-regen-${Date.now()}${path.extname(sourceEntry.name)}`;
    const destPath = path.join(inboxRoot, destName);
    await copyFile(sourcePath, destPath);

    const modePath = path.join(inboxRoot, `${destName}.mode.json`);
    await writeFile(modePath, JSON.stringify({ mode }, null, 2), 'utf8');

    return { ok: true, message: 'Cortes reprocessados e enviados ao worker.', fileName: destName, mode };
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code === 'ENOENT') {
      return reply.status(404).send({
        error: 'recording_not_found',
        message: 'Recording não encontrado.',
      });
    }
    request.log.error({ error, recordingId }, 'Falha ao reagendar gravação para regeneração');
    return reply.status(500).send({
      error: 'recording_regeneration_failed',
      message: 'Falha ao reagendar a regeneração dos cortes.',
    });
  }
});

app.get('/api/media/*', async (request, reply) => {
  const wildcard = (request.params as { '*': string })['*'];
  const normalizedRelative = path.normalize(wildcard).replace(/^(\.\.(\/|\\|$))+/, '');
  const absolutePath = path.resolve(mediaRoot, normalizedRelative);

  if (!absolutePath.startsWith(mediaRoot)) {
    return reply.status(400).send({
      error: 'invalid_media_path',
      message: 'Caminho inválido para mídia.',
    });
  }

  try {
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) {
      return reply.status(404).send({
        error: 'media_not_found',
        message: 'Arquivo de mídia não encontrado.',
      });
    }

    const range = request.headers.range;
    const contentType = detectMimeType(absolutePath);
    if (!range) {
      return reply
        .header('Content-Type', contentType)
        .header('Content-Length', fileStats.size)
        .send(createReadStream(absolutePath));
    }

    const [startToken, endToken] = range.replace('bytes=', '').split('-');
    const start = Number.parseInt(startToken, 10);
    const end = endToken ? Number.parseInt(endToken, 10) : fileStats.size - 1;
    const safeStart = Number.isNaN(start) ? 0 : Math.max(0, start);
    const safeEnd = Number.isNaN(end) ? fileStats.size - 1 : Math.min(end, fileStats.size - 1);

    if (safeStart > safeEnd) {
      return reply.status(416).send({
        error: 'invalid_range',
        message: 'Range inválido para o arquivo solicitado.',
      });
    }

    return reply
      .code(206)
      .header('Content-Range', `bytes ${safeStart}-${safeEnd}/${fileStats.size}`)
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', safeEnd - safeStart + 1)
      .header('Content-Type', contentType)
      .send(createReadStream(absolutePath, { start: safeStart, end: safeEnd }));
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code === 'ENOENT') {
      return reply.status(404).send({
        error: 'media_not_found',
        message: 'Arquivo de mídia não encontrado.',
      });
    }
    request.log.error({ error }, 'Falha ao servir mídia');
    return reply.status(500).send({
      error: 'media_stream_failed',
      message: 'Falha ao servir arquivo de mídia.',
    });
  }
});

app.get('/api/youtube/lives', async (request, reply) => {
  const { limit } = request.query as { limit?: string };
  const parsedLimit = limit ? Number.parseInt(limit, 10) : 20;

  if (limit && Number.isNaN(parsedLimit)) {
    return reply.status(400).send({
      error: 'invalid_limit',
      message: 'Parâmetro limit deve ser número inteiro.',
    });
  }

  try {
    const data = await listConnectedChannelLives(parsedLimit);
    return { data };
  } catch (error) {
    request.log.error({ error }, 'Falha ao listar lives reais da conta conectada');
    return reply.status(500).send({
      error: 'youtube_lives_list_failed',
      message: 'Falha ao listar lives no YouTube da conta conectada.',
    });
  }
});

app.get('/api/auth/youtube', async (request, reply) => {
  try {
    const authUrl = buildYoutubeAuthUrl();
    const { raw } = request.query as { raw?: string };
    if (raw === '1') {
      return { provider: 'youtube', authUrl };
    }
    return reply.redirect(authUrl);
  } catch (error) {
    request.log.error({ error }, 'Falha ao gerar URL do OAuth YouTube');
    return reply.status(500).send({
      error: 'youtube_oauth_not_configured',
      message: 'Configure YOUTUBE_CLIENT_ID e YOUTUBE_CLIENT_SECRET no .env.',
    });
  }
});

app.get('/api/auth/youtube/callback', async (request, reply) => {
  const { code } = request.query as { code?: string };
  const webAppUrl = process.env.WEB_APP_URL || 'http://127.0.0.1:5180';

  if (!code) {
    return reply.redirect(`${webAppUrl}/?youtube=error&reason=missing_authorization_code`);
  }

  try {
    await exchangeCodeAndPersistTokens(code);
    return reply.redirect(`${webAppUrl}/?youtube=connected`);
  } catch (error) {
    request.log.error({ error }, 'Falha no callback OAuth YouTube');
    return reply.redirect(`${webAppUrl}/?youtube=error&reason=oauth_callback_failed`);
  }
});

app.get('/api/auth/youtube/status', async (request, reply) => {
  try {
    return await getYoutubeConnectionStatus();
  } catch (error) {
    request.log.error({ error }, 'Falha ao validar conexão YouTube');
    return reply.status(500).send({
      error: 'youtube_status_check_failed',
      message: 'Falha ao consultar o status da conexão com YouTube.',
    });
  }
});

const start = async () => {
  const port = Number(process.env.PORT || 4100);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`API rodando em http://127.0.0.1:${port}`);
};

start().catch((error) => {
  console.error('Falha ao iniciar a API', error);
  process.exit(1);
});
