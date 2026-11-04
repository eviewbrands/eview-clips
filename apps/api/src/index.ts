import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

const buildVideoFilter = (kind: 'episodes' | 'shorts') => {
  if (kind === 'episodes') {
    return null;
  }

  return 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1';
};

type AiShortSuggestion = {
  id: string;
  start: number;
  end: number;
  duration: number;
  score: number;
  hook: string;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  provider: 'heuristic-v1';
};

const readJsonIfExists = async <T>(absolutePath: string) => {
  try {
    const raw = await readFile(absolutePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException;
    if (maybeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const normalizeSuggestion = (item: Partial<AiShortSuggestion> & { start?: number; duration?: number; score?: number; end?: number }, index: number): AiShortSuggestion => {
  const start = Number(item.start ?? 0);
  const duration = Math.max(8, Math.min(45, Number(item.duration ?? 18)));
  const end = Number(item.end ?? start + duration);
  const score = Math.min(99, Math.max(55, Number(item.score ?? 82)));

  return {
    id: item.id ?? `ai-short-${String(index + 1).padStart(2, '0')}`,
    start,
    end,
    duration,
    score: Math.round(score),
    hook: item.hook || 'Trecho com gatilho de reação e boa densidade de fala.',
    reason: item.reason || 'Trecho com bom ritmo, clareza e potencial de retenção para short.',
    risk: item.risk || (score >= 88 ? 'low' : score >= 78 ? 'medium' : 'high'),
    provider: item.provider || 'heuristic-v1',
  };
};

const buildHeuristicSuggestions = (clips: Array<{ id?: string; start: number; duration: number; transcriptPreview?: string }>) => {
  const seeds = clips.length
    ? clips
    : [
        { id: 'ai-short-01', start: 15, duration: 18, transcriptPreview: 'Pico de entusiasmo na abertura da live.' },
        { id: 'ai-short-02', start: 60, duration: 22, transcriptPreview: 'Momento de destaque com explicação narrativa.' },
        { id: 'ai-short-03', start: 120, duration: 20, transcriptPreview: 'Gatilho forte de reação com ação clara.' },
      ];

  const suggestions: AiShortSuggestion[] = seeds.slice(0, 5).map((clip, index) => {
    const transcriptPreview = clip.transcriptPreview ?? 'Trecho com impacto de contenção e ritmo forte.';
    const duration = Math.max(8, Math.min(30, clip.duration || 18));
    const start = Math.max(0, clip.start || index * 18);
    const scoreBase = 70 + (duration <= 20 ? 12 : 8) + (transcriptPreview.length > 20 ? 8 : 0) + (index === 0 ? 5 : 0);
    const score = Math.min(98, scoreBase);

    return {
      id: clip.id ?? `ai-short-${String(index + 1).padStart(2, '0')}`,
      start,
      end: start + duration,
      duration,
      score: Math.round(score),
      hook: transcriptPreview.slice(0, 110) || 'Trecho com gatilho de reação e boa faixa de fala.',
      reason: `Ritmo forte, boa clareza de fala e potencial de retenção para um short em ${duration}s.`,
      risk: score >= 88 ? 'low' : score >= 78 ? 'medium' : 'high',
      provider: 'heuristic-v1',
    };
  });

  return suggestions.sort((a, b) => b.score - a.score).slice(0, 5);
};

const parseAiSuggestionsPayload = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') {
    return [] as AiShortSuggestion[];
  }

  const container = raw as Record<string, unknown>;
  const candidates = Array.isArray(container.suggestions)
    ? container.suggestions
    : Array.isArray(container.candidates)
      ? container.candidates
      : Array.isArray(container.data)
        ? container.data
        : [];

  if (!Array.isArray(candidates)) {
    return [] as AiShortSuggestion[];
  }

  return candidates
    .map((entry, index) => normalizeSuggestion(entry as Partial<AiShortSuggestion>, index))
    .filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.duration) && entry.duration > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
};

const callGeminiForSuggestions = async (clips: Array<{ id?: string; start: number; duration: number; transcriptPreview?: string }>) => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return null;
  }

  const payload = {
    contents: [{
      parts: [{
        text: `Você é um especialista em virais de shorts para lives e vídeos longos. Analise os trechos abaixo e devolva APENAS JSON válido, sem markdown. Regras: 1) responda com array de sugestoes; 2) cada item deve conter id, start, end, duration, score, hook, reason, risk; 3) score de 0 a 100; 4) priorize trechos com gatilho emocional, frase forte, ritmo, clareza e potencial de retenção; 5) não invente trechos fora da lista; 6) cada recomendação deve ter start/end em segundos. JSON object format: {"suggestions":[{...}]}\nTrechos:\n${JSON.stringify(clips.slice(0, 10), null, 2)}`,
      }],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  };

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Gemini API respondeu com status ${response.status}`);
  }

  const result = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = result.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  if (!text) {
    return null;
  }

  const cleanedText = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(cleanedText) as unknown;
  const suggestions = parseAiSuggestionsPayload(parsed);
  return suggestions.length ? suggestions : null;
};

const callOpenAiForSuggestions = async (clips: Array<{ id?: string; start: number; duration: number; transcriptPreview?: string }>) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.AI_SHORTS_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: 'Você analisa trechos de live e retorna apenas JSON com sugestões de shorts curtos com potencial de viralização.',
      }, {
        role: 'user',
        content: `Considere os trechos abaixo e retorne {"suggestions":[{"id":"...","start":0,"end":12,"duration":12,"score":90,"hook":"...","reason":"...","risk":"low"}]}. Priorize temas emocionais, frases fortes, ritmo e retenção.\n${JSON.stringify(clips.slice(0, 10), null, 2)}`,
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API respondeu com status ${response.status}`);
  }

  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = result.choices?.[0]?.message?.content ?? '';
  if (!content) {
    return null;
  }

  return parseAiSuggestionsPayload(JSON.parse(content));
};

const generateAiShortSuggestions = async (recordingDir: string) => {
  const segmentsPath = path.join(recordingDir, 'segments.json');
  const segmentPlan = await readJsonIfExists<{
    episodes?: Array<{ id?: string; start: number; duration: number; transcriptPreview?: string }>;
    shorts?: Array<{ id?: string; start: number; duration: number; transcriptPreview?: string }>;
  }>(segmentsPath);

  const clips = [...((segmentPlan?.shorts ?? []).map((clip) => ({ ...clip, kind: 'shorts' as const }))), ...((segmentPlan?.episodes ?? []).map((clip) => ({ ...clip, kind: 'episodes' as const })))];

  const candidateClips = clips.length ? clips : [
    { id: 'ai-short-01', start: 15, duration: 18, transcriptPreview: 'Pico de entusiasmo na abertura da live.', kind: 'shorts' as const },
    { id: 'ai-short-02', start: 60, duration: 22, transcriptPreview: 'Momento de destaque com explicação narrativa.', kind: 'shorts' as const },
    { id: 'ai-short-03', start: 120, duration: 20, transcriptPreview: 'Gatilho forte de reação com ação clara.', kind: 'shorts' as const },
  ];

  const provider = (process.env.AI_SHORTS_PROVIDER || (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? 'gemini' : process.env.OPENAI_API_KEY ? 'openai' : 'heuristic')).toLowerCase();

  try {
    if (provider === 'openai') {
      const suggestions = await callOpenAiForSuggestions(candidateClips);
      if (suggestions && suggestions.length) {
        return suggestions.map((item) => ({ ...item, provider: 'heuristic-v1' as const }));
      }
    }

    if (provider === 'gemini') {
      const suggestions = await callGeminiForSuggestions(candidateClips);
      if (suggestions && suggestions.length) {
        return suggestions.map((item) => ({ ...item, provider: 'heuristic-v1' as const }));
      }
    }
  } catch (error) {
    console.warn('AI short proposal failed, using heuristic fallback:', error);
  }

  return buildHeuristicSuggestions(candidateClips as Array<{ id?: string; start: number; duration: number; transcriptPreview?: string }>);
};

const renderClipToFile = async (
  sourcePath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number,
  kind: 'episodes' | 'shorts' = 'episodes',
) => {
  const { spawn } = await import('node:child_process');
  const videoFilter = buildVideoFilter(kind);

  return new Promise<void>((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-y',
      '-ss',
      String(startSeconds),
      '-i',
      sourcePath,
      '-t',
      String(durationSeconds),
      ...(videoFilter ? ['-vf', videoFilter] : []),
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
    ];

    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

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
    await renderClipToFile(sourcePath, outputPath, startSeconds, durationSeconds, kind);
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

app.post('/api/recordings/:recordingId/ai-shorts/analyze', async (request, reply) => {
  const { recordingId } = request.params as { recordingId: string };
  if (!recordingId) {
    return reply.status(400).send({
      error: 'missing_recording_id',
      message: 'recordingId é obrigatório.',
    });
  }

  const recordingDir = path.join(mediaRoot, 'recordings', recordingId);
  try {
    await mkdir(recordingDir, { recursive: true });
    const sourceEntry = (await readdir(recordingDir, { withFileTypes: true })).find(
      (entry) => entry.isFile() && entry.name.startsWith('source.'),
    );
    if (!sourceEntry) {
      return reply.status(404).send({
        error: 'source_not_found',
        message: 'Arquivo de origem da gravação não encontrado.',
      });
    }

    const suggestions = await generateAiShortSuggestions(recordingDir);
    const payload = {
      provider: 'heuristic-v1',
      generatedAt: new Date().toISOString(),
      suggestions,
    };
    await writeFile(path.join(recordingDir, 'ai-shorts.json'), JSON.stringify(payload, null, 2), 'utf8');

    return {
      ok: true,
      provider: 'heuristic-v1',
      message: 'Sugestões de shorts geradas por IA heurística.',
      data: suggestions,
    };
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code === 'ENOENT') {
      return reply.status(404).send({
        error: 'recording_not_found',
        message: 'Recording não encontrado.',
      });
    }
    request.log.error({ error, recordingId }, 'Falha ao gerar sugestões de shorts por IA');
    return reply.status(500).send({
      error: 'ai_short_analysis_failed',
      message: 'Falha ao analisar o vídeo para sugerir shorts.',
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
