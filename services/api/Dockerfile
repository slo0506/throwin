# Build from the repo root: docker build -f services/api/Dockerfile .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/api/package.json services/api/
RUN pnpm install --frozen-lockfile --filter @throwin/api...
COPY packages/shared packages/shared
COPY services/api services/api
RUN pnpm --filter @throwin/api... build \
  && pnpm --filter @throwin/api deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
