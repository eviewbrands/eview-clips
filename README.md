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

## Dados

Todos os arquivos persistem em `./data` para sobreviver a reinicialização dos containers.

## Observações

- O projeto é um MVP local e usa o YouTube apenas como API externa.
- A autenticação e permissões de canal devem ser configuradas no `.env` e no Google Cloud.
