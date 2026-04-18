# syntax=docker/dockerfile:1.6

# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies before copying to runtime image
RUN npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -S app && adduser -S -G app app \
 && mkdir -p /data && chown -R app:app /data

ENV NODE_ENV=production \
    QBO_CREDENTIAL_MODE=local \
    QBO_CREDENTIAL_FILE=/data/qbo-credentials.json \
    QBO_INLINE_OUTPUT=true \
    PORT=8080

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json

# Persist OAuth tokens across restarts. Mount a named volume or bind-mount.
VOLUME /data

USER app
EXPOSE 8080

CMD ["node", "dist/http-server.js"]
