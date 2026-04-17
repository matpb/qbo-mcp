# syntax=docker/dockerfile:1.6

# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies before copying to runtime image
RUN npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root runtime user
RUN addgroup -S app && adduser -S -G app app

ENV NODE_ENV=production \
    QBO_CREDENTIAL_MODE=gcp \
    QBO_INLINE_OUTPUT=true \
    PORT=8080

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json

USER app
EXPOSE 8080

CMD ["node", "dist/cloud-run.js"]
