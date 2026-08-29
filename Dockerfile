# Hosted hub server image (Railway). Node's engines pin is 22.20.0 <23 /
# npm 10.9.3 <11 (see package.json "engines") — the base image below matches
# that exactly so `npm ci` doesn't fail the engines check.
#
# Two stages so the runtime image only ever installs production dependencies:
# devDependencies (tsup, vitest, tsx, ...) never ship. Neither stage copies a
# host node_modules — `better-sqlite3` and `node-pty` (and any other native
# optional dep) must be compiled for this image's platform, not whatever built
# the image on the developer's machine.

FROM node:22.20-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22.20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# /healthz is unauthenticated (src/hub/server.ts) — safe for Railway's health
# checker to hit with no credentials.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||4760,path:'/healthz'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["npm", "start"]
