FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg && rm -rf /var/lib/apt/lists/*
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1

WORKDIR /workspace
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm install

CMD ["npm", "run", "dev", "--workspace", "@eview-clips/api"]
