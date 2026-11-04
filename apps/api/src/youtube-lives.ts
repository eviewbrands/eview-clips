import type { youtube_v3 } from 'googleapis';
import { getAuthenticatedYoutubeClient } from './youtube-auth.js';

export interface YoutubeLiveSummary {
  videoId: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  scheduledStartTime: string | null;
  actualStartTime: string | null;
  actualEndTime: string | null;
  privacyStatus: string | null;
  duration: string | null;
  liveBroadcastContent: string | null;
  videoUrl: string;
}

const pickMainThumbnail = (thumbnails?: youtube_v3.Schema$ThumbnailDetails | null) =>
  thumbnails?.maxres?.url ??
  thumbnails?.standard?.url ??
  thumbnails?.high?.url ??
  thumbnails?.medium?.url ??
  thumbnails?.default?.url ??
  null;

const unique = <T>(items: T[]) => Array.from(new Set(items));

const isLiveLikeVideo = (video: youtube_v3.Schema$Video) => {
  const liveData = video.liveStreamingDetails;
  const snippet = video.snippet;
  return Boolean(
    liveData?.actualStartTime ||
      liveData?.scheduledStartTime ||
      snippet?.liveBroadcastContent === 'live' ||
      snippet?.liveBroadcastContent === 'upcoming',
  );
};

const mapLiveVideo = (video: youtube_v3.Schema$Video): YoutubeLiveSummary => {
  const id = video.id ?? '';
  const snippet = video.snippet;
  const details = video.liveStreamingDetails;

  return {
    videoId: id,
    title: snippet?.title ?? 'Sem título',
    description: snippet?.description ?? '',
    thumbnailUrl: pickMainThumbnail(snippet?.thumbnails),
    publishedAt: snippet?.publishedAt ?? null,
    scheduledStartTime: details?.scheduledStartTime ?? null,
    actualStartTime: details?.actualStartTime ?? null,
    actualEndTime: details?.actualEndTime ?? null,
    privacyStatus: video.status?.privacyStatus ?? null,
    duration: video.contentDetails?.duration ?? null,
    liveBroadcastContent: snippet?.liveBroadcastContent ?? null,
    videoUrl: `https://www.youtube.com/watch?v=${id}`,
  };
};

export const listConnectedChannelLives = async (limit = 20): Promise<YoutubeLiveSummary[]> => {
  const normalizedLimit = Number.isNaN(limit) ? 20 : Math.min(Math.max(limit, 1), 50);
  const { youtube, channel } = await getAuthenticatedYoutubeClient();
  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;

  if (!uploadsPlaylistId) {
    throw new Error('Canal autenticado sem playlist de uploads disponível.');
  }

  const playlistVideoIds: string[] = [];
  let pageToken: string | undefined;

  while (playlistVideoIds.length < normalizedLimit * 4) {
    const playlistPage = await youtube.playlistItems.list({
      part: ['contentDetails'],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    });

    const pageIds = (playlistPage.data.items ?? [])
      .map((item) => item.contentDetails?.videoId)
      .filter((id): id is string => Boolean(id));

    playlistVideoIds.push(...pageIds);
    pageToken = playlistPage.data.nextPageToken ?? undefined;
    if (!pageToken || pageIds.length === 0) {
      break;
    }
  }

  const ids = unique(playlistVideoIds);
  if (ids.length === 0) {
    return [];
  }

  const allVideos: youtube_v3.Schema$Video[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const videosResponse = await youtube.videos.list({
      part: ['snippet', 'status', 'contentDetails', 'liveStreamingDetails'],
      id: chunk,
      maxResults: 50,
    });
    allVideos.push(...(videosResponse.data.items ?? []));
  }

  const liveVideos = allVideos.filter(isLiveLikeVideo).map(mapLiveVideo);
  liveVideos.sort((a, b) => {
    const aDate = a.actualStartTime ?? a.scheduledStartTime ?? a.publishedAt ?? '';
    const bDate = b.actualStartTime ?? b.scheduledStartTime ?? b.publishedAt ?? '';
    return bDate.localeCompare(aDate);
  });

  return liveVideos.slice(0, normalizedLimit);
};
