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

# Type-check source
COPY tsconfig.json ./
COPY src/ src/
COPY public/ public/
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────
FROM node:22-bookworm-slim

WORKDIR /app

# Copy full node_modules from build (including devDeps like tsx).
# @meteora-ag/dlmm -> @coral-xyz/anchor has ESM/CJS compat issues
# that break with pruned deps. Keeping full tree is the simplest fix.
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/package.json package.json

# Copy TypeScript source (tsx runs from source)
COPY src/ src/
COPY tsconfig.json ./
COPY public/ public/

EXPOSE 8789

CMD ["npx", "tsx", "src/controlPanel.ts"]
