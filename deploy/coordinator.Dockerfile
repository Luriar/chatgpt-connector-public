FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev && mkdir -p /data && chown -R node:node /app /data
COPY --chown=node:node scripts/coordinator-server.js /app/scripts/coordinator-server.js
COPY --chown=node:node src/net-safe.js /app/src/net-safe.js
EXPOSE 8765
VOLUME ["/data"]
USER node
CMD ["node","/app/scripts/coordinator-server.js","--host","0.0.0.0","--port","8765","--data","/data/state.json","--blob-dir","/data/blobs"]
