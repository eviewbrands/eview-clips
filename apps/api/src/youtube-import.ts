import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import ytdl from '@distube/ytdl-core';
import { youtubeDl, type JSRuntimeLocation } from 'youtube-dl-exec';

type ProgressCallback = (percent: number, stage: string) => void;
type YtDlpOptions = NonNullable<Parameters<typeof youtubeDl>[1]>;

const sanitizeFileName = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

const pickCaptionTrack = (info: Awaited<ReturnType<typeof ytdl.getInfo>>) => {
  const tracks =
    info.player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) {
    return null;
  }
  const preferred =
    tracks.find((track) => track.languageCode?.startsWith('pt')) ||
    tracks.find((track) => track.vssId?.includes('a.')) ||
    tracks[0];
  return preferred ?? null;
};

const downloadTranscriptVtt = async (
  info: Awaited<ReturnType<typeof ytdl.getInfo>>,
  outputPath: string,
) => {
  const track = pickCaptionTrack(info);
  if (!track?.baseUrl) {
    return false;
  }
  const separator = track.baseUrl.includes('?') ? '&' : '?';
  const vttUrl = `${track.baseUrl}${separator}fmt=vtt`;
  const response = await fetch(vttUrl);
  if (!response.ok) {
    return false;
  }
  const body = await response.text();
  if (!body.includes('WEBVTT')) {
    return false;
  }
  await writeFile(outputPath, body, 'utf8');
  return true;
};

const splitEnvList = (value: string | undefined) =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0) ?? [];

const isJsRuntimeLocation = (value: string): value is JSRuntimeLocation => {
  const [runtime] = value.split(':', 1);
  return runtime === 'node' || runtime === 'bun' || runtime === 'quickjs' || runtime === 'deno';
};

const resolveCookiesCandidatePath = (inboxRoot: string) => {
  const configuredCookiesFile = process.env.YTDLP_COOKIES_FILE?.trim();
  if (configuredCookiesFile) {
    return path.isAbsolute(configuredCookiesFile)
      ? configuredCookiesFile
      : path.resolve(process.cwd(), configuredCookiesFile);
  }
  return path.resolve(inboxRoot, '..', '..', 'youtube', 'cookies.txt');
};

const hasUsableCookiesFile = async (absolutePath: string) => {
  try {
    const fileStats = await stat(absolutePath);
    return fileStats.isFile() && fileStats.size > 0;
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException;
    if (maybeError.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const buildYtDlpOptions = async (targetPath: string, inboxRoot: string): Promise<YtDlpOptions> => {
  const options: YtDlpOptions = {
    output: targetPath,
    format: 'bv*+ba/b',
    mergeOutputFormat: 'mp4',
    noPlaylist: true,
    noCheckCertificates: true,
    preferFreeFormats: false,
    noPart: true,
  };

  const cookiesCandidatePath = resolveCookiesCandidatePath(inboxRoot);
  if (await hasUsableCookiesFile(cookiesCandidatePath)) {
    options.cookies = cookiesCandidatePath;
  }

  const cookiesFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (cookiesFromBrowser) {
    options.cookiesFromBrowser = cookiesFromBrowser;
  }

  const jsRuntimes = splitEnvList(process.env.YTDLP_JS_RUNTIMES).filter(isJsRuntimeLocation);
  if (jsRuntimes.length === 1) {
    options.jsRuntimes = jsRuntimes[0];
  } else if (jsRuntimes.length > 1) {
    options.jsRuntimes = jsRuntimes;
  }

  return options;
};

export const importYoutubeVideoToInbox = async (
  videoId: string,
  inboxRoot: string,
  onProgress?: ProgressCallback,
): Promise<{ fileName: string; title: string; transcriptFileName: string | null }> => {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let info: Awaited<ReturnType<typeof ytdl.getInfo>> | null = null;
  try {
    info = await ytdl.getInfo(videoUrl);
  } catch {
    info = null;
  }

  const title = info?.videoDetails.title || videoId;
  const baseName = sanitizeFileName(title) || videoId;
  const fileName = `${baseName}-${videoId}-${Date.now()}.mp4`;
  const transcriptFileName = `${baseName}-${videoId}-${Date.now()}.vtt`;
  const targetPath = path.join(inboxRoot, fileName);
  const transcriptPath = path.join(inboxRoot, transcriptFileName);

  await mkdir(inboxRoot, { recursive: true });
  onProgress?.(0, 'starting');

  try {
    onProgress?.(10, 'downloading-with-yt-dlp');
    const ytDlpOptions = await buildYtDlpOptions(targetPath, inboxRoot);
    await youtubeDl(videoUrl, ytDlpOptions);
    onProgress?.(90, 'downloaded');

    if (!info) {
      try {
        info = await ytdl.getInfo(videoUrl);
      } catch {
        info = null;
      }
    }
    const hasTranscript = info ? await downloadTranscriptVtt(info, transcriptPath) : false;
    onProgress?.(100, 'completed');
    return { fileName, title, transcriptFileName: hasTranscript ? transcriptFileName : null };
  } catch (primaryError) {
    await unlink(targetPath).catch(() => undefined);
    await unlink(transcriptPath).catch(() => undefined);
    try {
      onProgress?.(15, 'fallback-ytdl-core');
      if (!info) {
        throw new Error(`Não foi possível obter informações da live ${videoId} via ytdl-core.`);
      }

      const format =
        ytdl.chooseFormat(info.formats, {
          quality: 'highest',
          filter: (item) => item.hasAudio && item.hasVideo && item.container === 'mp4',
        }) ||
        ytdl.chooseFormat(info.formats, {
          quality: 'highest',
          filter: (item) => item.hasAudio && item.hasVideo,
        });

      if (!format) {
        throw new Error(`Nenhum formato compatível encontrado para ${videoId} via ytdl-core.`);
      }

      const stream = ytdl.downloadFromInfo(info, { format });
      stream.on('progress', (_chunkLength, downloaded, total) => {
        const percent = total > 0 ? Math.min(99, Math.floor((downloaded / total) * 100)) : 15;
        onProgress?.(percent, 'downloading');
      });

      const writer = createWriteStream(targetPath);
      stream.pipe(writer);
      await finished(writer);
      const hasTranscript = await downloadTranscriptVtt(info, transcriptPath);
      onProgress?.(100, 'completed');
      return { fileName, title, transcriptFileName: hasTranscript ? transcriptFileName : null };
    } catch (fallbackError) {
      await unlink(targetPath).catch(() => undefined);
      throw new Error(
        `Falha ao importar live ${videoId}. yt-dlp: ${
          primaryError instanceof Error ? primaryError.message : String(primaryError)
        }; ytdl-core: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
  }
};
