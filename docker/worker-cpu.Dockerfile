FROM node:22-bookworm-slim

WORKDIR /workspace
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
COPY transcriber ./transcriber
RUN npm install

CMD ["npm", "run", "dev", "--workspace", "@eview-clips/worker"]
