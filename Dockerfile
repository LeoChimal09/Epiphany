FROM oven/bun:1.3.14 AS bun
FROM node:24-bookworm-slim AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
RUN bun install --frozen-lockfile
COPY . .
# Builds must not open the production database or need provider credentials.
RUN bun run build

FROM base AS runtime
ENV NODE_ENV=production PORT=3000 WORKER_HEALTH_PORT=3001
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
RUN mkdir -p /data && chmod 700 /data
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "Promise.all([fetch('http://127.0.0.1:'+process.env.PORT+'/api/health'),fetch('http://127.0.0.1:'+process.env.WORKER_HEALTH_PORT+'/health')]).then(rs=>{if(rs.some(r=>!r.ok))process.exit(1)}).catch(()=>process.exit(1))"
CMD ["bun", "scripts/start-app.ts"]
