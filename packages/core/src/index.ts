export const APP_NAME = 'Eview Clips';

export type WorkerMode = 'cpu' | 'gpu' | 'mac';
export type EncoderMode = 'x264' | 'nvenc' | 'videotoolbox';

export interface RuntimeConfig {
  workerMode: WorkerMode;
  encoder: EncoderMode;
  dataDir: string;
}

export const defaultRuntimeConfig: RuntimeConfig = {
  workerMode: 'cpu',
  encoder: 'x264',
  dataDir: './data',
};

export interface RecordingSummary {
  id: string;
  sourcePath: string;
  status: 'queued' | 'processing' | 'rendered' | 'published';
  createdAt: string;
}

export const createRecordingSummary = (
  id: string,
  sourcePath: string,
): RecordingSummary => ({
  id,
  sourcePath,
  status: 'queued',
  createdAt: new Date().toISOString(),
});
