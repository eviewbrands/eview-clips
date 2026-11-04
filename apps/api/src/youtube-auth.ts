import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import type { youtube_v3 } from 'googleapis';

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const resolvePathFromWorkspace = (configuredPath: string) => {
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  const cwd = process.cwd();
  if (path.basename(path.dirname(cwd)) === 'apps') {
    return path.resolve(cwd, '..', '..', configuredPath);
  }

  return path.resolve(cwd, configuredPath);
};

const tokenPath = resolvePathFromWorkspace(
  process.env.YOUTUBE_TOKEN_PATH || './data/oauth/youtube-token.json',
);

const getOAuthClient = () => {
  const clientId = process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.YOUTUBE_REDIRECT_URI || 'http://127.0.0.1:4100/api/auth/youtube/callback';

  if (!clientId || !clientSecret) {
    throw new Error(
      'Credenciais ausentes. Configure YOUTUBE_CLIENT_ID e YOUTUBE_CLIENT_SECRET no .env.',
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
};

const ensureTokenDir = async () => {
  await mkdir(path.dirname(tokenPath), { recursive: true });
};

const loadStoredTokens = async () => {
  const tokenRaw = await readFile(tokenPath, 'utf8');
  const tokens = JSON.parse(tokenRaw) as Record<string, unknown>;

  if (!tokens.access_token && !tokens.refresh_token) {
    throw new Error(`Arquivo de token sem credenciais utilizáveis em ${tokenPath}`);
  }

  return tokens;
};

const pickMainThumbnail = (thumbnails?: youtube_v3.Schema$ThumbnailDetails | null) =>
  thumbnails?.maxres?.url ??
  thumbnails?.standard?.url ??
  thumbnails?.high?.url ??
  thumbnails?.medium?.url ??
  thumbnails?.default?.url ??
  null;

export const buildYoutubeAuthUrl = () => {
  const oauth2Client = getOAuthClient();

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: YOUTUBE_SCOPES,
    prompt: 'consent',
  });
};

export const exchangeCodeAndPersistTokens = async (code: string) => {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  await ensureTokenDir();
  await writeFile(tokenPath, JSON.stringify(tokens, null, 2), 'utf8');
  return tokens;
};

export const getYoutubeConnectionStatus = async () => {
  const oauth2Client = getOAuthClient();

  try {
    const tokens = await loadStoredTokens();
    oauth2Client.setCredentials(tokens);
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const response = await youtube.channels.list({ part: ['id', 'snippet'], mine: true });
    const channel = response.data.items?.[0];

    if (!channel) {
      return { connected: false as const, reason: 'channel_not_found_for_account' };
    }

    return {
      connected: true as const,
      channelId: channel.id ?? null,
      channelTitle: channel.snippet?.title ?? null,
      channelHandle: channel.snippet?.customUrl ?? null,
      channelThumbnailUrl: pickMainThumbnail(channel.snippet?.thumbnails),
    };
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code === 'ENOENT') {
      return { connected: false as const, reason: 'token_file_not_found' };
    }
    throw error;
  }
};

export const getAuthenticatedYoutubeClient = async () => {
  const oauth2Client = getOAuthClient();
  const tokens = await loadStoredTokens();
  oauth2Client.setCredentials(tokens);

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const response = await youtube.channels.list(
    { part: ['id', 'snippet', 'contentDetails'], mine: true },
  );
  const channel = response.data.items?.[0];

  if (!channel) {
    throw new Error('Nenhum canal encontrado para a conta autenticada.');
  }

  return {
    youtube,
    channel,
  };
};
