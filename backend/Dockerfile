FROM node:24.22.1-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg poppler-utils fonts-dejavu-core util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend .
RUN npm run db:generate
RUN npm run build
USER node
EXPOSE 4000 4001
CMD ["node", "dist/api/src/main.js"]
