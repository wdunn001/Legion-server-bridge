# Two-stage build: install + tsc inside, then run from a slim runtime.
# node-datachannel ships prebuilt binaries for linux-x64/arm64; no native
# toolchain needed in either stage.

FROM node:20-slim AS build
WORKDIR /app

# Copy package metadata first so the install layer caches across source
# edits.
COPY package.json package-lock.json* ./

# The bridge file:-deps the local @unstable-legion/core checkout. In the
# image we ship that checkout under ./vendor/unstable-legion-core/ and
# rewrite the file: path during install via a temp package.json shim.
# Simpler approach: COPY the core package in BEFORE npm install and use
# the file: path as-is.
COPY vendor/ ./vendor/
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.dependencies['@unstable-legion/core']='file:./vendor/unstable-legion-core';fs.writeFileSync('package.json',JSON.stringify(p,null,2));"
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app

COPY package.json ./
# Materialize vendor so the runtime can resolve the local file: dep.
COPY --from=build /app/vendor/ ./vendor/
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/

# Rewrite the dep path in the runtime image's package.json too so npm
# (if invoked) doesn't try to fetch from the registry.
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.dependencies['@unstable-legion/core']='file:./vendor/unstable-legion-core';fs.writeFileSync('package.json',JSON.stringify(p,null,2));"

# Default cmd — config via env vars per README.
CMD ["node", "dist/cli.js"]
