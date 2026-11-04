# Eview Clips MVP

Projeto local para processamento de lives, transcrição de áudio, cortes por código e renders de shorts.

## Estrutura

- `apps/api`: Fastify + TypeScript para OAuth do YouTube, listagem de lives e endpoints de status.
- `apps/web`: painel React + Vite para revisão de episódios, shorts e publicação.
- `apps/worker`: pipeline de ingestão, transcrição, segmento e render.
- `packages/core`: tipos e schemas compartilhados.
- `db/migrations`: SQL inicial do banco.
- `transcriber`: scripts e dependências para o modelo de fala.
- `data/`: montado localmente e não versionado.

## Primeiros passos

```bash
cd /mnt/www/eview/eview-clips
npm run setup
npm install
npm run up
```

## Variáveis de ambiente

O script `npm run setup` gera o `.env` a partir do `.env.example`, detectando a plataforma e escolhendo o melhor perfil de worker.

- Linux com NVIDIA: `WORKER_MODE=gpu`, `ENCODER=nvenc`
- macOS com Apple Silicon: `WORKER_MODE=mac`, `ENCODER=videotoolbox`
- qualquer outra máquina: `WORKER_MODE=cpu`, `ENCODER=x264`

## Conectar conta do YouTube

1. Crie um projeto no Google Cloud e habilite a API **YouTube Data API v3**.
2. Em **OAuth consent screen**, configure app externa em modo de teste e adicione seu e-mail como test user.
3. Em **Credentials**, crie um OAuth Client do tipo **Web application** com redirect:
   - `http://127.0.0.1:4100/api/auth/youtube/callback`
4. No `.env`, preencha:
   - `YOUTUBE_CLIENT_ID`
   - `YOUTUBE_CLIENT_SECRET`
   - `YOUTUBE_REDIRECT_URI` (mantém o valor acima)
   - `YOUTUBE_TOKEN_PATH=./data/oauth/youtube-token.json`
5. Reinicie a API (`docker compose restart api`).
6. Abra no navegador:
   - `http://127.0.0.1:4100/api/auth/youtube`
7. Após autorizar, valide:
   - `http://127.0.0.1:4100/api/auth/youtube/status`

Após autorizar, o callback redireciona automaticamente para a home do painel (`WEB_APP_URL`) com o status de conexão.
Quando conectado, o token fica salvo localmente em `data/oauth/youtube-token.json`.

## Dados

Todos os arquivos persistem em `./data` para sobreviver a reinicialização dos containers.

## Como os cortes são feitos hoje

O worker processa arquivos reais em `data/media/inbox`:

1. espera o arquivo estabilizar (fim da cópia);
2. move para `data/media/recordings/<id>/source.<ext>`;
3. mede duração com `ffprobe`;
4. detecta pausas com `silencedetect` e lê transcrição (VTT) da live quando disponível;
5. gera `segments.json` com o plano de cortes baseado em silêncio + texto transcrito;
6. renderiza com FFmpeg em `data/media/renders/<id>/`:
   - `episodes/`: janelas grandes (~30-50 min) fechando em pausas naturais e fim de frase;
   - `shorts/`: trechos curtos de 15-60s priorizando pausas + densidade textual da transcrição.

Perfil de encode usado pelo worker depende do `.env`:
- `ENCODER=nvenc`: `h264_nvenc`
- `ENCODER=videotoolbox`: `h264_videotoolbox`
- `ENCODER=x264`: `libx264`

## Studio Web (fluxo completo pela interface)

Com o painel em `http://127.0.0.1:5180` você já consegue:

1. conectar a conta do YouTube;
2. ver lives reais do canal (thumbnail e metadados);
3. clicar em uma live para abrir uma página dedicada de corte (`/cut/:videoId`);
4. iniciar download + corte dessa live sem upload manual do computador;
5. acompanhar progresso do download e da renderização;
6. ver clipes planejados por silêncio + transcrição e abrir clipes renderizados.

## Observações

- O projeto é um MVP local e usa o YouTube apenas como API externa.
- A autenticação e permissões de canal devem ser configuradas no `.env` e no Google Cloud.
