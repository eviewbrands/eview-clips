import { defaultRuntimeConfig, type RuntimeConfig } from '@eview-clips/core';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

type TranscriptCue = {
  start: number;
  end: number;
  text: string;
};

type PlannedClip = {
  id: string;
  type: 'episode' | 'short';
  start: number;
  duration: number;
  score: number;
  transcriptPreview: string;
};

type ProcessingStatus = {
  phase:
    | 'queued'
    | 'ingesting'
    | 'analyzing-transcript'
    | 'detecting-silence'
    | 'planning-cuts'
    | 'planned'
    | 'rendering'
    | 'completed'
    | 'failed';
  renderedCuts: number;
  totalCuts: number;
  message: string;
  updatedAt: string;
};

const runtime: RuntimeConfig = {
  ...defaultRuntimeConfig,
  workerMode: (process.env.WORKER_MODE as RuntimeConfig['workerMode']) || defaultRuntimeConfig.workerMode,
  encoder: (process.env.ENCODER as RuntimeConfig['encoder']) || defaultRuntimeConfig.encoder,
  dataDir: process.env.DATA_DIR || defaultRuntimeConfig.dataDir,
};

const SUPPORTED_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);
const POLL_INTERVAL_MS = 30000;
const FILE_STABILITY_WAIT_MS = 2500;
const processing = new Set<string>();

const resolveDataRoot = () => {
  if (path.isAbsolute(runtime.dataDir)) {
    return runtime.dataDir;
  }
  const cwd = process.cwd();
  if (path.basename(path.dirname(cwd)) === 'apps') {
    return path.resolve(cwd, '..', '..', runtime.dataDir);
  }
  return path.resolve(cwd, runtime.dataDir);
};

const resolveDataPath = (...parts: string[]) => path.resolve(resolveDataRoot(), ...parts);
const paths = {
  inbox: resolveDataPath('media', 'inbox'),
  recordings: resolveDataPath('media', 'recordings'),
  renders: resolveDataPath('media', 'renders'),
  tmp: resolveDataPath('media', 'tmp'),
};

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const runCommand = async (command: string, args: string[]) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
      }
    });
  });

const ensureLayout = async () => {
  await mkdir(paths.inbox, { recursive: true });
  await mkdir(paths.recordings, { recursive: true });
  await mkdir(paths.renders, { recursive: true });
  await mkdir(paths.tmp, { recursive: true });
};

const toRecordingId = (baseName: string) =>
  `${baseName.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}-${Date.now()}`;

const fileAppearsStable = async (absolutePath: string) => {
  const first = await stat(absolutePath);
  await wait(FILE_STABILITY_WAIT_MS);
  const second = await stat(absolutePath);
  return first.size > 0 && first.size === second.size;
};

const getVideoDurationSeconds = async (absolutePath: string) => {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    absolutePath,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Duração inválida retornada pelo ffprobe para ${absolutePath}`);
  }
  return duration;
};

const parseSeconds = (value: string) => {
  const [hh, mm, rest] = value.trim().split(':');
  const [ss, ms = '0'] = rest.split('.');
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
};

const parseVttTranscript = async (vttPath: string): Promise<TranscriptCue[]> => {
  try {
    const raw = await readFile(vttPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const cues: TranscriptCue[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line.includes('-->')) {
        continue;
      }
      const [startToken, endToken] = line.split('-->').map((part) => part.trim().split(' ')[0]);
      const start = parseSeconds(startToken.replace(',', '.'));
      const end = parseSeconds(endToken.replace(',', '.'));
      const textLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '') {
        textLines.push(lines[j].replace(/<[^>]+>/g, '').trim());
        j += 1;
      }
      const text = textLines.join(' ').trim();
      if (text) {
        cues.push({ start, end, text });
      }
      i = j;
    }
    return cues;
  } catch {
    return [];
  }
};

const detectSilencePoints = async (sourcePath: string) => {
  const { stderr } = await runCommand('ffmpeg', [
    '-hide_banner',
    '-i',
    sourcePath,
    '-af',
    'silencedetect=n=-34dB:d=0.6',
    '-f',
    'null',
    '-',
  ]);
  const points: number[] = [];
  const silenceStartRegex = /silence_start:\s*([0-9.]+)/g;
  const silenceEndRegex = /silence_end:\s*([0-9.]+)/g;
  for (const regex of [silenceStartRegex, silenceEndRegex]) {
    let match: RegExpExecArray | null = regex.exec(stderr);
    while (match) {
      points.push(Number.parseFloat(match[1]));
      match = regex.exec(stderr);
    }
  }
  return points.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
};

const transcriptPreviewForWindow = (cues: TranscriptCue[], start: number, end: number) =>
  cues
    .filter((cue) => cue.end >= start && cue.start <= end)
    .map((cue) => cue.text)
    .join(' ')
    .slice(0, 180);

const chooseBoundary = (
  min: number,
  max: number,
  target: number,
  candidates: number[],
) => {
  const inRange = candidates.filter((value) => value >= min && value <= max);
  if (inRange.length === 0) {
    return Math.min(max, target);
  }
  let best = inRange[0];
  let bestDistance = Math.abs(best - target);
  for (const value of inRange.slice(1)) {
    const distance = Math.abs(value - target);
    if (distance < bestDistance) {
      best = value;
      bestDistance = distance;
    }
  }
  return best;
};

const buildEpisodeSegments = (
  durationSeconds: number,
  silencePoints: number[],
  transcriptCues: TranscriptCue[],
): PlannedClip[] => {
  const transcriptEnds = transcriptCues
    .filter((cue) => /[.!?]$/.test(cue.text))
    .map((cue) => cue.end);
  const candidates = [...silencePoints, ...transcriptEnds].sort((a, b) => a - b);

  const clips: PlannedClip[] = [];
  let cursor = 0;
  const target = 40 * 60;
  const min = 30 * 60;
  const max = 50 * 60;
  let index = 1;

  while (cursor < durationSeconds - 30) {
    const remaining = durationSeconds - cursor;
    if (remaining <= min && clips.length > 0) {
      clips[clips.length - 1].duration += remaining;
      break;
    }
    const segmentMin = cursor + Math.min(min, remaining);
    const segmentMax = cursor + Math.min(max, remaining);
    const segmentTarget = cursor + Math.min(target, remaining);
    const end = chooseBoundary(segmentMin, segmentMax, segmentTarget, candidates);
    const duration = Math.max(15, end - cursor);
    clips.push({
      id: `episode-${String(index).padStart(2, '0')}`,
      type: 'episode',
      start: cursor,
      duration,
      score: 1,
      transcriptPreview: transcriptPreviewForWindow(transcriptCues, cursor, cursor + duration),
    });
    cursor += duration;
    index += 1;
  }
  return clips;
};

const buildShortSegments = (
  durationSeconds: number,
  silencePoints: number[],
  transcriptCues: TranscriptCue[],
): PlannedClip[] => {
  const boundaries = [0, ...silencePoints.filter((p) => p > 0 && p < durationSeconds), durationSeconds];
  boundaries.sort((a, b) => a - b);
  const clips: PlannedClip[] = [];

  const addShort = (start: number, duration: number, preview: string) => {
    if (duration < 15 || duration > 60) {
      return;
    }
    const safeStart = Math.max(0, Math.min(durationSeconds - duration, start));
    const safeDuration = Math.max(15, Math.min(60, duration));
    clips.push({
      id: `short-${String(clips.length + 1).padStart(3, '0')}`,
      type: 'short',
      start: safeStart,
      duration: safeDuration,
      score: preview.length + Math.max(0, 60 - Math.abs(35 - safeDuration)),
      transcriptPreview: preview,
    });
  };

  for (let i = 1; i < boundaries.length; i += 1) {
    const start = boundaries[i - 1];
    const end = boundaries[i];
    const duration = end - start;
    const preview = transcriptPreviewForWindow(transcriptCues, start, end);
    if (duration >= 15 && duration <= 60 && preview.length >= 24) {
      addShort(start, duration, preview);
      continue;
    }

    if (duration < 15 && end > start + 15) {
      const fallbackDuration = Math.min(45, end - start);
      const fallbackStart = start + Math.max(0, (duration - fallbackDuration) / 2);
      addShort(fallbackStart, fallbackDuration, preview || 'Gameplay sem narração — janela de destaque do vídeo.');
    }
  }

  if (clips.length === 0) {
    const fallbackChunk = 30;
    for (let start = 0; start < durationSeconds; start += fallbackChunk) {
      const duration = Math.min(45, durationSeconds - start);
      if (duration < 15) continue;
      const preview = transcriptPreviewForWindow(transcriptCues, start, start + duration);
      addShort(start, duration, preview || 'Gameplay sem narração — janela gerada automaticamente.');
    }
  }

  return clips.sort((a, b) => b.score - a.score).slice(0, 24).sort((a, b) => a.start - b.start);
};

const buildVideoEncoderArgs = (encoder: RuntimeConfig['encoder']) => {
  if (encoder === 'nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23'];
  if (encoder === 'videotoolbox') return ['-c:v', 'h264_videotoolbox', '-b:v', '5500k'];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];
};

const renderCut = async (
  sourcePath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number,
) => {
  const runWithEncoder = async (encoder: RuntimeConfig['encoder']) =>
    runCommand('ffmpeg', [
      '-hide_banner',
      '-y',
      '-ss',
      String(startSeconds),
      '-i',
      sourcePath,
      '-t',
      String(durationSeconds),
      ...buildVideoEncoderArgs(encoder),
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      outputPath,
    ]);

  try {
    await runWithEncoder(runtime.encoder);
  } catch (error) {
    if (runtime.encoder === 'x264') throw error;
    console.error(`[worker] encoder ${runtime.encoder} indisponível, fallback x264`, error);
    await runWithEncoder('x264');
  }
};

const writeStatus = async (recordingDir: string, partial: Partial<ProcessingStatus>) => {
  const statusPath = path.join(recordingDir, 'status.json');
  let current: ProcessingStatus = {
    phase: 'queued',
    renderedCuts: 0,
    totalCuts: 0,
    message: '',
    updatedAt: new Date().toISOString(),
  };
  try {
    const raw = await readFile(statusPath, 'utf8');
    current = JSON.parse(raw) as ProcessingStatus;
  } catch {
    current = {
      phase: 'queued',
      renderedCuts: 0,
      totalCuts: 0,
      message: '',
      updatedAt: new Date().toISOString(),
    };
  }
  const next: ProcessingStatus = {
    ...current,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(statusPath, JSON.stringify(next, null, 2), 'utf8');
};

const readInboxMode = async (fileName: string): Promise<'all' | 'shorts' | 'episodes'> => {
  const modeFile = path.join(paths.inbox, `${fileName}.mode.json`);
  try {
    const raw = await readFile(modeFile, 'utf8');
    const parsed = JSON.parse(raw) as { mode?: 'all' | 'shorts' | 'episodes' };
    if (parsed.mode === 'shorts' || parsed.mode === 'episodes') {
      return parsed.mode;
    }
  } catch {
    // noop
  }
  return 'all';
};

const processInboxFile = async (fileName: string) => {
  const sourceInInbox = path.join(paths.inbox, fileName);
  if (!(await fileAppearsStable(sourceInInbox))) {
    console.log(`[worker] arquivo ainda em cópia: ${fileName}`);
    return;
  }

  const generationMode = await readInboxMode(fileName);
  const ext = path.extname(fileName).toLowerCase();
  const baseName = path.basename(fileName, ext);
  const recordingId = toRecordingId(baseName);
  const recordingDir = path.join(paths.recordings, recordingId);
  const sourceInRecording = path.join(recordingDir, `source${ext}`);
  const sidecarTranscriptInbox = path.join(paths.inbox, `${baseName}.vtt`);
  const sidecarTranscriptRecording = path.join(recordingDir, 'transcript.vtt');
  const renderRoot = path.join(paths.renders, recordingId);
  const episodesDir = path.join(renderRoot, 'episodes');
  const shortsDir = path.join(renderRoot, 'shorts');

  await mkdir(recordingDir, { recursive: true });
  await mkdir(episodesDir, { recursive: true });
  await mkdir(shortsDir, { recursive: true });
  await writeStatus(recordingDir, { phase: 'ingesting', message: 'Movendo arquivo para recording.' });

  await rename(sourceInInbox, sourceInRecording);
  await rm(path.join(paths.inbox, `${fileName}.mode.json`), { force: true }).catch(() => undefined);
  try {
    await stat(sidecarTranscriptInbox);
    await rename(sidecarTranscriptInbox, sidecarTranscriptRecording);
  } catch {
    // transcript sidecar é opcional
  }

  await writeStatus(recordingDir, {
    phase: 'analyzing-transcript',
    message: 'Analisando transcrição da live.',
  });
  const transcriptCues = await parseVttTranscript(sidecarTranscriptRecording);

  await writeStatus(recordingDir, {
    phase: 'detecting-silence',
    message: 'Detectando pausas/silêncio no áudio.',
  });
  const durationSeconds = await getVideoDurationSeconds(sourceInRecording);
  const silencePoints = await detectSilencePoints(sourceInRecording);

  await writeStatus(recordingDir, {
    phase: 'planning-cuts',
    message: 'Montando plano de cortes por silêncio + transcrição.',
  });
  const episodes = generationMode === 'shorts' ? [] : buildEpisodeSegments(durationSeconds, silencePoints, transcriptCues);
  const shorts = generationMode === 'episodes' ? [] : buildShortSegments(durationSeconds, silencePoints, transcriptCues);
  const plan = {
    recordingId,
    source: sourceInRecording,
    durationSeconds,
    strategy: 'silence+transcript',
    outputFormats: {
      episodes: '16:9',
      shorts: '9:16',
    },
    transcriptCueCount: transcriptCues.length,
    silencePointCount: silencePoints.length,
    mode: generationMode,
    episodes,
    shorts,
  };
  await writeFile(path.join(recordingDir, 'segments.json'), JSON.stringify(plan, null, 2), 'utf8');

  const totalCuts = episodes.length + shorts.length;
  await writeStatus(recordingDir, {
    phase: 'planned',
    renderedCuts: 0,
    totalCuts,
    message: totalCuts === 0
      ? 'Nenhum corte foi planejado para esta live.'
      : 'Plano pronto. Você pode abrir o vídeo original no tempo exato ou renderizar só os cortes que quiser.',
  });
  console.log(`[worker] plano pronto para ${recordingId} (${totalCuts} cortes planejados)`);
};

const runCycle = async () => {
  const entryNames = await readdir(paths.inbox, { encoding: 'utf8' });
  const videoEntries: string[] = [];
  for (const fileName of entryNames) {
    const absolutePath = path.join(paths.inbox, fileName);
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) continue;
    if (!SUPPORTED_EXTENSIONS.has(path.extname(fileName).toLowerCase())) continue;
    videoEntries.push(fileName);
  }

  for (const fileName of videoEntries) {
    const absolutePath = path.join(paths.inbox, fileName);
    if (processing.has(absolutePath)) continue;
    processing.add(absolutePath);
    try {
      await processInboxFile(fileName);
    } catch (error) {
      console.error(`[worker] falha ao processar ${fileName}`, error);
    } finally {
      processing.delete(absolutePath);
    }
  }
};

const start = async () => {
  await ensureLayout();
  await runCycle();
  setInterval(() => {
    runCycle().catch((error) => {
      console.error('[worker] falha no ciclo de processamento', error);
    });
  }, POLL_INTERVAL_MS);
};

console.log('Eview Clips worker inicializado');
console.log(JSON.stringify({ runtime }, null, 2));

start().catch((error) => {
  console.error('[worker] falha ao iniciar pipeline', error);
  process.exit(1);
});
