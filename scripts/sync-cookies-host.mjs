import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const API_BASE_URL = process.env.EVIEW_API_URL || 'http://127.0.0.1:4100';
const REFRESH_ENDPOINT = `${API_BASE_URL.replace(/\/$/, '')}/api/youtube/cookies/refresh`;
const PROBE_URL = process.env.YOUTUBE_PROBE_URL || 'https://www.youtube.com/';

const isSupportedBrowser = (browser) => {
  if (process.platform !== 'darwin' && browser === 'safari') {
    return false;
  }
  return true;
};

const browserCandidates = ['safari', 'chrome', 'chromium', 'firefox', 'edge', 'brave'].filter(
  isSupportedBrowser,
);

const checkCommand = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0;
};

const runCommand = (command, args) =>
  spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const summarizeYtDlpError = (raw) => {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errorLine = lines.find((line) => line.startsWith('ERROR:'));
  if (errorLine) {
    return errorLine;
  }
  return lines[0] ?? 'falha desconhecida';
};

const isLikelyNetscapeCookies = (raw) => {
  const content = raw.trim();
  if (!content) {
    return false;
  }
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (!lines.length) {
    return false;
  }
  return lines.some((line) => line.toLowerCase().includes('youtube.com') && line.split('\t').length >= 7);
};

const postCookiesToApi = async (cookiesText) => {
  const response = await fetch(REFRESH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'clipboard',
      cookiesText,
    }),
  });

  const raw = await response.text();
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { message: raw };
  }

  if (!response.ok) {
    const message =
      typeof body === 'object' && body && 'message' in body
        ? String(body.message)
        : `HTTP ${response.status}`;
    throw new Error(`Falha ao enviar cookies para API: ${message}`);
  }

  return typeof body === 'object' && body && 'message' in body
    ? String(body.message)
    : 'Cookies sincronizados com sucesso.';
};

const readClipboardText = () => {
  if (process.platform === 'darwin') {
    const result = runCommand('pbpaste', []);
    if (result.status === 0) return result.stdout;
    return '';
  }
  if (process.platform === 'linux') {
    const candidates = [
      ['wl-paste', ['-n']],
      ['xclip', ['-selection', 'clipboard', '-o']],
      ['xsel', ['--clipboard', '--output']],
    ];
    for (const [command, args] of candidates) {
      if (!checkCommand(command, ['--version'])) {
        continue;
      }
      const result = runCommand(command, args);
      if (result.status === 0 && result.stdout.trim()) {
        return result.stdout;
      }
    }
  }
  return '';
};

const getApiStatus = async () => {
  const response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/api/youtube/cookies/status`);
  if (!response.ok) {
    throw new Error(`Falha ao consultar status da API (HTTP ${response.status}).`);
  }
  return response.json();
};

if (!checkCommand('yt-dlp', ['--version'])) {
  console.error('yt-dlp não encontrado no host. Instale e tente novamente.');
  process.exit(1);
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'eview-cookies-'));
const tempCookiesPath = path.join(tempDir, 'youtube-cookies.txt');

const tryExtractCookies = (browser) => {
  const result = runCommand(
    'yt-dlp',
    [
      '--cookies-from-browser',
      browser,
      '--cookies',
      tempCookiesPath,
      '--skip-download',
      '--simulate',
      '--no-warnings',
      PROBE_URL,
    ],
  );
  return {
    ok: result.status === 0,
    error:
      result.status === 0
        ? ''
        : summarizeYtDlpError(result.stderr || result.stdout || 'falha desconhecida'),
  };
};

const hasValidCookiesFile = async () => {
  try {
    const fileStats = await stat(tempCookiesPath);
    return fileStats.isFile() && fileStats.size > 0;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

try {
  let selectedBrowser = null;
  const browserErrors = [];
  for (const browser of browserCandidates) {
    process.stdout.write(`Tentando extrair cookies de ${browser}...\n`);
    await rm(tempCookiesPath, { force: true });
    const extraction = tryExtractCookies(browser);
    if (await hasValidCookiesFile()) {
      selectedBrowser = browser;
      break;
    }
    if (!extraction.ok) {
      if (extraction.error) {
        browserErrors.push(`${browser}: ${extraction.error}`);
      }
      continue;
    }
    browserErrors.push(`${browser}: arquivo de cookies não foi gerado`);
  }

  let successMessage = '';
  if (!selectedBrowser) {
    const clipboardText = readClipboardText();
    if (isLikelyNetscapeCookies(clipboardText)) {
      successMessage = await postCookiesToApi(clipboardText);
      process.stdout.write('Cookies enviados via clipboard do host.\n');
    } else {
      throw new Error(
        `Falha ao extrair cookies automaticamente do host.\n\n` +
          `Tentativas:\n- ${browserErrors.join('\n- ')}\n\n` +
          'Solução sem painel: faça login no YouTube no navegador do HOST, copie os cookies no formato Netscape para o clipboard e rode novamente: npm run cookies:sync',
      );
    }
  } else {
    const cookiesText = await readFile(tempCookiesPath, 'utf8');
    successMessage = await postCookiesToApi(cookiesText);
    process.stdout.write(`Cookies extraídos do browser: ${selectedBrowser}\n`);
  }

  const status = await getApiStatus();
  process.stdout.write(`${successMessage}\n`);
  process.stdout.write(`Status final: configured=${String(status.configured)} source=${String(status.source ?? 'none')}\n`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
