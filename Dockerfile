# QORGAN — образ для публичного размещения (docs/DEPLOYMENT.md).
# Для обычного локального запуска на Windows Docker НЕ нужен: npm install → npm run setup → npm run dev.

# ---- сборка интерфейса ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- запуск ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/qorgan.db \
    BACKUP_DIR=/data/backups \
    WEB_ROOT=/app/apps/web/dist
WORKDIR /app
COPY --from=build --chown=node:node /app /app
# База SQLite и резервные копии — в томе /data: переживают пересоздание контейнера.
RUN mkdir -p /data/backups && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tsx запускается напрямую (не через npm), чтобы SIGTERM доходил до сервера и БД закрывалась корректно.
CMD ["./node_modules/.bin/tsx", "apps/server/src/server.ts"]
