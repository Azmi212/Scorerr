FROM node:24-bookworm-slim AS production-dependencies

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/scorerr.db
WORKDIR /app
RUN groupadd --system --gid 10001 scorerr \
    && useradd --system --uid 10001 --gid scorerr --home-dir /app scorerr \
    && mkdir -p /data \
    && chown scorerr:scorerr /data
COPY --from=build --chown=scorerr:scorerr /app/package.json /app/package-lock.json ./
COPY --from=production-dependencies --chown=scorerr:scorerr /app/node_modules ./node_modules
COPY --from=build --chown=scorerr:scorerr /app/dist ./dist
COPY --from=build --chown=scorerr:scorerr /app/drizzle ./drizzle
USER scorerr
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/api/server.js"]
