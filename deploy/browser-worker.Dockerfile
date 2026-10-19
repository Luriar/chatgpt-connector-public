FROM node:22-bookworm-slim
WORKDIR /app
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends chromium chromium-sandbox ca-certificates wget fonts-liberation fonts-noto-cjk fonts-noto-color-emoji xvfb x11vnc novnc websockify fluxbox \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev
COPY scripts/browser-worker.js /app/scripts/browser-worker.js
COPY scripts/browser-nas-entrypoint.sh /app/scripts/browser-nas-entrypoint.sh
COPY deploy/novnc-index.html /usr/share/novnc/index.html
COPY src/net-safe.js /app/src/net-safe.js
RUN chmod +x /app/scripts/browser-nas-entrypoint.sh \
 && mkdir -p /home/node/.cache /browser-profile /nas \
 && chown -R node:node /app /home/node /browser-profile
ENV HOME=/home/node
ENV WEBJJONKU_BROWSER_EXECUTABLE=/usr/bin/chromium
ENV DISPLAY=:99
ENV WEBJJONKU_BROWSER_HEADLESS=0
ENV WEBJJONKU_BROWSER_KEEP_OPEN=1
ENV WEBJJONKU_BROWSER_IDLE_CLOSE_MS=0
ENV WEBJJONKU_BROWSER_CDP_URL=
USER node
CMD ["/app/scripts/browser-nas-entrypoint.sh"]
