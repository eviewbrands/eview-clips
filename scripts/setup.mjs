import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const envExamplePath = path.join(root, '.env.example');
const envPath = path.join(root, '.env');

if (!existsSync(envExamplePath)) {
  throw new Error('Arquivo .env.example não encontrado no diretório do projeto.');
}

const requiredDirs = [
  'data',
  'data/media/inbox',
  'data/media/recordings',
  'data/media/renders',
  'data/media/tmp',
  'data/models',
  'data/postgres',
  'backups',
];

for (const dir of requiredDirs) {
  mkdirSync(path.join(root, dir), { recursive: true });
}

const currentPlatform = process.platform;
let workerMode = 'cpu';
let encoder = 'x264';

if (currentPlatform === 'linux') {
  try {
    execSync('nvidia-smi >/dev/null 2>&1', { stdio: 'ignore' });
    workerMode = 'gpu';
    encoder = 'nvenc';
  } catch {
    workerMode = 'cpu';
    encoder = 'x264';
  }
} else if (currentPlatform === 'darwin') {
  workerMode = 'mac';
  encoder = 'videotoolbox';
}

const envExample = readFileSync(envExamplePath, 'utf8');
const nextEnv = envExample
  .replace(/UID=.*/gm, `UID=${process.getuid ? process.getuid() : 1000}`)
  .replace(/GID=.*/gm, `GID=${process.getgid ? process.getgid() : 1000}`)
  .replace(/WORKER_MODE=.*/gm, `WORKER_MODE=${workerMode}`)
  .replace(/ENCODER=.*/gm, `ENCODER=${encoder}`)
  .replace(/DATA_DIR=.*/gm, 'DATA_DIR=./data');

writeFileSync(envPath, nextEnv);
console.log(`Ambiente configurado em ${envPath}`);
console.log(`Perfil detectado: ${workerMode} (${encoder})`);
