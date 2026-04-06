# ── Build stage ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Install build tools for native modules (node-gyp needs python3, make, g++)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Install all deps (cache layer)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ src/
COPY public/ public/
RUN npm run build

# Prune devDependencies in-place so we can copy node_modules to runtime
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────
FROM node:22-bookworm-slim

WORKDIR /app

# Copy pre-built node_modules (with native modules already compiled)
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/package.json package.json

# Copy compiled output and static assets
COPY --from=build /app/dist/ dist/
COPY public/ public/

# The data directory and wallet are mounted as volumes — not baked in
# .env is mounted via env_file in docker-compose

EXPOSE 8789

CMD ["node", "dist/src/controlPanel.js"]
