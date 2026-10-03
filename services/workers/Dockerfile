# Build from the repo root: docker build -f services/workers/Dockerfile .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/workers/package.json services/workers/
RUN pnpm install --frozen-lockfile --filter @throwin/workers...
COPY packages/shared packages/shared
COPY services/workers services/workers
RUN pnpm --filter @throwin/workers... build \
  && pnpm --filter @throwin/workers deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
CMD ["node", "dist/index.js"]
