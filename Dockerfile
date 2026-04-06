# ── Build stage ────────────────────────────────────────────────
FROM node:current-bookworm-slim AS build

WORKDIR /app

# Install build tools for native modules (node-gyp needs python3, make, g++)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Install all deps (cache layer)
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript and keep dist for verification
COPY tsconfig.json ./
COPY src/ src/
COPY public/ public/
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────
FROM node:23-bookworm-slim

WORKDIR /app

# Keep full node_modules (tsx needed at runtime for ESM/CJS interop)
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/package.json package.json

COPY src/ src/
COPY tsconfig.json ./
COPY public/ public/

# Patch @meteora-ag/dlmm to use CJS build instead of ESM (.mjs).
# The .mjs build does `import { BN } from "@coral-xyz/anchor"` which fails
# because anchor has no ESM exports. Forcing CJS avoids the issue entirely.
RUN node -e "\
const fs = require('fs'); \
const p = '/app/node_modules/@meteora-ag/dlmm/package.json'; \
const pkg = JSON.parse(fs.readFileSync(p, 'utf8')); \
delete pkg.module; \
pkg.exports = { '.': { 'require': './dist/index.js', 'default': './dist/index.js' } }; \
fs.writeFileSync(p, JSON.stringify(pkg, null, 2)); \
console.log('Patched DLMM to use CJS');"

EXPOSE 8789

CMD ["node", "--experimental-require-module", "--import", "tsx", "src/controlPanel.ts"]
