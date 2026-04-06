# ── Build stage ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Install deps first (cache layer)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ src/
COPY public/ public/
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────
FROM node:22-bookworm-slim

WORKDIR /app

# Install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output and static assets
COPY --from=build /app/dist/ dist/
COPY public/ public/

# The data directory and wallet are mounted as volumes — not baked in
# .env is mounted via env_file in docker-compose

EXPOSE 8789

CMD ["node", "dist/src/controlPanel.js"]
