import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });

const hasCommand = (command) => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;

const installYtDlpIfMissing = () => {
  if (hasCommand('yt-dlp')) {
    return;
  }

  if (process.platform === 'darwin') {
    if (!hasCommand('brew')) {
      throw new Error(
        'yt-dlp não encontrado e Homebrew não está instalado. Instale o Homebrew no host macOS e rode novamente.',
      );
    }
    const install = run('brew', ['install', 'yt-dlp']);
    if (install.status !== 0) {
      throw new Error('Falha ao instalar yt-dlp com brew.');
    }
    return;
  }

  if (process.platform === 'linux') {
    if (hasCommand('apt-get')) {
      const update = run('sudo', ['apt-get', 'update']);
      if (update.status !== 0) {
        throw new Error('Falha ao executar sudo apt-get update.');
      }
      const install = run('sudo', ['apt-get', 'install', '-y', 'yt-dlp']);
      if (install.status !== 0) {
        throw new Error('Falha ao instalar yt-dlp com apt-get.');
      }
      return;
    }
    if (hasCommand('dnf')) {
      const install = run('sudo', ['dnf', 'install', '-y', 'yt-dlp']);
      if (install.status !== 0) {
        throw new Error('Falha ao instalar yt-dlp com dnf.');
      }
      return;
    }
    if (hasCommand('pacman')) {
      const install = run('sudo', ['pacman', '-S', '--noconfirm', 'yt-dlp']);
      if (install.status !== 0) {
        throw new Error('Falha ao instalar yt-dlp com pacman.');
      }
      return;
    }
  }

  throw new Error(
    'yt-dlp não encontrado e não foi possível detectar um gerenciador suportado. Instale yt-dlp no host e tente novamente.',
  );
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const syncScript = path.join(__dirname, 'sync-cookies-host.mjs');

try {
  installYtDlpIfMissing();
  const sync = run('node', [syncScript]);
  if (sync.status !== 0) {
    process.exit(sync.status ?? 1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
