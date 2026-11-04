import { createWriteStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import ytdl from '@distube/ytdl-core';
import { youtubeDl } from 'youtube-dl-exec';

type ProgressCallback = (percent: number, stage: string) => void;

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
      const percent = total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : 0;
      onProgress?.(percent, 'downloading');
    });

    const writer = createWriteStream(targetPath);
    stream.pipe(writer);
    await finished(writer);
    onProgress?.(100, 'downloaded');

    const hasTranscript = await downloadTranscriptVtt(info, transcriptPath);
    return { fileName, title, transcriptFileName: hasTranscript ? transcriptFileName : null };
  } catch (primaryError) {
    await unlink(targetPath).catch(() => undefined);
    await unlink(transcriptPath).catch(() => undefined);
    try {
      onProgress?.(10, 'fallback-downloader');
      await youtubeDl(videoUrl, {
        output: targetPath,
        format: 'bv*+ba/b',
        mergeOutputFormat: 'mp4',
        noPlaylist: true,
        noCheckCertificates: true,
        preferFreeFormats: false,
      });
      onProgress?.(100, 'downloaded');
      return { fileName, title, transcriptFileName: null };
    } catch (fallbackError) {
      await unlink(targetPath).catch(() => undefined);
      throw new Error(
        `Falha ao importar live ${videoId}. ytdl-core: ${
          primaryError instanceof Error ? primaryError.message : String(primaryError)
        }; yt-dlp: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
  }
};
