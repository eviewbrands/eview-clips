FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1
WORKDIR /workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
  curl ca-certificates git python3 python3-pip ffmpeg && \
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
  apt-get install -y nodejs && \
  rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
COPY transcriber ./transcriber
RUN npm install

CMD ["npm", "run", "dev", "--workspace", "@eview-clips/worker"]
