FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

FROM dependencies AS source
COPY . .

FROM source AS test
CMD ["sh", "-c", "npm test && npm run lint && npx next typegen && npm run typecheck"]

FROM source AS build
ENV NEXT_PUBLIC_SAVEFLOW_API_MODE=http
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM dependencies AS migrate
COPY migrations ./migrations
COPY scripts/migrate-banking.mjs ./scripts/migrate-banking.mjs
CMD ["node", "scripts/migrate-banking.mjs"]

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ARG SAVEFLOW_GIT_SHA=unknown
ARG SAVEFLOW_GIT_DIRTY=unknown
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 SAVEFLOW_GIT_SHA=$SAVEFLOW_GIT_SHA SAVEFLOW_GIT_DIRTY=$SAVEFLOW_GIT_DIRTY
LABEL org.opencontainers.image.revision=$SAVEFLOW_GIT_SHA org.openai.saveflow.git-sha=$SAVEFLOW_GIT_SHA org.openai.saveflow.git-dirty=$SAVEFLOW_GIT_DIRTY
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/out ./out
COPY server ./server
COPY src ./src
COPY scripts/serve-container.mjs ./scripts/serve-container.mjs
COPY scripts/purchase-worker.mjs ./scripts/
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "scripts/serve-container.mjs"]
