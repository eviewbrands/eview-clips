import Fastify from 'fastify';
import { APP_NAME, createRecordingSummary } from '@eview-clips/core';

const app = Fastify({ logger: true });

app.get('/health', async () => ({ ok: true, app: APP_NAME, timestamp: new Date().toISOString() }));

app.get('/api/health', async () => ({ ok: true, app: APP_NAME, timestamp: new Date().toISOString() }));

app.get('/api/recordings', async () => ({
  data: [
    createRecordingSummary('live-001', 'recordings/live-001/source.mp4'),
    createRecordingSummary('live-002', 'recordings/live-002/source.mp4'),
  ],
}));

app.get('/api/auth/youtube', async () => ({
  provider: 'youtube',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  hint: 'Configure o Google OAuth no .env antes de testar.',
}));

const start = async () => {
  const port = Number(process.env.PORT || 4100);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`API rodando em http://127.0.0.1:${port}`);
};

start().catch((error) => {
  console.error('Falha ao iniciar a API', error);
  process.exit(1);
});
