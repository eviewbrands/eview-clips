import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface RenderedClip {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface AiShortSuggestion {
  id: string;
  start: number;
  end: number;
  duration: number;
  score: number;
  hook: string;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  provider: 'heuristic-v1';
}

export interface RecordingStudioItem {
  id: string;
  sourcePath: string;
  status: 'queued' | 'planned' | 'processing' | 'rendered' | 'published';
  createdAt: string;
  sourceSizeBytes: number;
  processing?: {
    phase: string;
    renderedCuts: number;
    totalCuts: number;
    message: string;
    updatedAt: string;
  };
  plannedEpisodes: Array<{ id: string; start: number; duration: number; transcriptPreview: string }>;
  plannedShorts: Array<{ id: string; start: number; duration: number; transcriptPreview: string }>;
  aiShorts: AiShortSuggestion[];
  episodes: RenderedClip[];
  shorts: RenderedClip[];
}

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

const isMissingPathError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'ENOENT';

const discoverSourcePath = async (recordingDir: string) => {
  const files = await readdir(recordingDir, { withFileTypes: true, encoding: 'utf8' });
  const sourceFile = files.find((entry) => entry.isFile() && entry.name.startsWith('source.'));
  return sourceFile ? sourceFile.name : null;
};

const listRenderedClips = async (absoluteDir: string, relativePrefix: string) => {
  try {
    const entries = await readdir(absoluteDir, { withFileTypes: true, encoding: 'utf8' });
    const clips: RenderedClip[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.mp4') {
        continue;
      }
      const absolutePath = path.join(absoluteDir, entry.name);
      const fileStats = await stat(absolutePath);
      clips.push({
        name: entry.name,
        path: path.posix.join(relativePrefix, entry.name),
        sizeBytes: fileStats.size,
      });
    }

    return clips.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
};

const detectRecordingStatus = (episodesCount: number, shortsCount: number, hasSegments: boolean) => {
  if (episodesCount > 0 || shortsCount > 0) {
    return 'rendered' as const;
  }
  if (hasSegments) {
    return 'planned' as const;
  }
  return 'queued' as const;
};

const readJsonIfExists = async <T>(absolutePath: string) => {
  try {
    const raw = await readFile(absolutePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    return null;
  }
};

export const listRecordingSummaries = async (): Promise<RecordingStudioItem[]> => {
  const dataDir = resolveDataDir();
  const recordingsRoot = path.join(dataDir, 'media', 'recordings');
  const rendersRoot = path.join(dataDir, 'media', 'renders');

  let recordingsDirs;
  try {
    recordingsDirs = await readdir(recordingsRoot, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const summaries: RecordingStudioItem[] = [];
  const dirEntries = recordingsDirs.filter((entry) => entry.isDirectory());

  for (const entry of dirEntries) {
    const recordingDir = path.join(recordingsRoot, entry.name);
    const sourceFile = await discoverSourcePath(recordingDir);
    if (!sourceFile) {
      continue;
    }

    const sourceAbsolutePath = path.join(recordingDir, sourceFile);
    const sourceStats = await stat(sourceAbsolutePath);
    const segmentsPath = path.join(recordingDir, 'segments.json');
    const statusPath = path.join(recordingDir, 'status.json');
    const aiShortsPath = path.join(recordingDir, 'ai-shorts.json');

    let hasSegments = false;
    try {
      await stat(segmentsPath);
      hasSegments = true;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }

    const episodes = await listRenderedClips(
      path.join(rendersRoot, entry.name, 'episodes'),
      path.posix.join('renders', entry.name, 'episodes'),
    );
    const shorts = await listRenderedClips(
      path.join(rendersRoot, entry.name, 'shorts'),
      path.posix.join('renders', entry.name, 'shorts'),
    );

    const plan = await readJsonIfExists<{
      episodes?: Array<{ id: string; start: number; duration: number; transcriptPreview?: string }>;
      shorts?: Array<{ id: string; start: number; duration: number; transcriptPreview?: string }>;
    }>(segmentsPath);
    const processing = await readJsonIfExists<{
      phase: string;
      renderedCuts: number;
      totalCuts: number;
      message: string;
      updatedAt: string;
    }>(statusPath);
    const aiShortSuggestions = await readJsonIfExists<{
      suggestions?: AiShortSuggestion[];
    }>(aiShortsPath);

    summaries.push({
      id: entry.name,
      sourcePath: path.posix.join('recordings', entry.name, sourceFile),
      status: detectRecordingStatus(episodes.length, shorts.length, hasSegments),
      createdAt: sourceStats.birthtime.toISOString(),
      sourceSizeBytes: sourceStats.size,
      processing: processing ?? undefined,
      plannedEpisodes: (plan?.episodes ?? []).map((item) => ({
        id: item.id ?? `episode-${Math.round(item.start)}`,
        start: item.start,
        duration: item.duration,
        transcriptPreview: item.transcriptPreview ?? '',
      })),
      plannedShorts: (plan?.shorts ?? []).map((item) => ({
        id: item.id ?? `short-${Math.round(item.start)}`,
        start: item.start,
        duration: item.duration,
        transcriptPreview: item.transcriptPreview ?? '',
      })),
      aiShorts: aiShortSuggestions?.suggestions ?? [],
      episodes,
      shorts,
    });
  }

  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};
