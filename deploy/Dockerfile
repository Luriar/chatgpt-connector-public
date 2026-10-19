# ChatGPT Connector server image for NAS / always-on deployment
FROM node:22-bookworm-slim

# SSH/Git for remote work, Docker CLI for sandboxing through a mounted host socket.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client ca-certificates git curl docker.io \
 && git config --system --add safe.directory /workspace \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY harness ./harness
COPY scripts ./scripts
COPY skills ./skills

RUN mkdir -p /workspace /nas && chown -R node:node /app /workspace
WORKDIR /workspace

EXPOSE 8747
CMD ["node", "/app/src/index.js", "--http", "--host", "0.0.0.0", "--port", "8747"]