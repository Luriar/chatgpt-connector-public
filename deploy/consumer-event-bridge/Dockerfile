FROM node:22-alpine
WORKDIR /opt/consumer-event-bridge
COPY apps/consumer-event-bridge/package.json apps/consumer-event-bridge/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY apps/consumer-event-bridge/src ./src
COPY apps/consumer-event-bridge/ui ./ui
USER node
ENV CONSUMER_EVENT_DATA=/data CONSUMER_EVENT_PORT=18795 CONSUMER_EVENT_HOST=127.0.0.1
EXPOSE 18795
CMD ["node","src/server.mjs"]
