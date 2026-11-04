import { defaultRuntimeConfig, type RuntimeConfig } from '@eview-clips/core';

const runtime: RuntimeConfig = {
  ...defaultRuntimeConfig,
  workerMode: (process.env.WORKER_MODE as RuntimeConfig['workerMode']) || defaultRuntimeConfig.workerMode,
  encoder: (process.env.ENCODER as RuntimeConfig['encoder']) || defaultRuntimeConfig.encoder,
  dataDir: process.env.DATA_DIR || defaultRuntimeConfig.dataDir,
};

const jobs = [
  'ingest',
  'transcribe',
  'segment',
  'render',
  'publish',
];

console.log('Eview Clips worker inicializado');
console.log(JSON.stringify({ runtime, jobs }, null, 2));

setInterval(() => {
  console.log(`[worker:${runtime.workerMode}] aguardando jobs na fila...`);
}, 30000);
