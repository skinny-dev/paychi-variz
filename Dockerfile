# Paychi Variz server. One process, SQLite on a persistent volume at /app/data.
# Node 22.13+ is required for the built-in node:sqlite module.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/paychi.db

WORKDIR /app

# Dependencies first so they are cached between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
# public/ includes public/downloads/paychi-listener.apk when it exists in the build context
# (it is gitignored; otherwise set APK_URL).
COPY public ./public

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "server/index.js"]
