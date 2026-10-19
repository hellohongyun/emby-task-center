# syntax=docker/dockerfile:1.7
ARG BUILD_VERSION=1.0.4
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace

# 工作区清单层：只复制清单，让 pnpm 能正确解析 workspace:* 依赖，并让依赖安装层可缓存。
# 必须包含全部 workspace 成员清单（apps/* 与 packages/*），否则 pnpm 无法解析根包声明的
# @emby-task-center/* workspace 依赖。
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/task-domain/package.json packages/task-domain/package.json

FROM manifests AS build
ARG BUILD_VERSION
RUN node -e "const expected=require('./package.json').version; if(process.argv[1]!==expected) throw new Error('BUILD_VERSION must match package.json version '+expected)" "$BUILD_VERSION"
RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile
RUN pnpm --version \
    && pnpm list --recursive --depth -1 \
    && node -e "const expected=require('./package.json').packageManager.replace(/^pnpm@/, ''); const actual=require('node:child_process').execFileSync('pnpm', ['--version'], {encoding:'utf8'}).trim(); if(actual!==expected) throw new Error('pnpm version mismatch: expected '+expected+', got '+actual)"
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm --filter @emby-task-center/web exec node -e "for(const dependency of ['motion-v','@testing-library/vue','@vue/tsconfig']) console.log(dependency+' -> '+require.resolve(dependency)); const ts=require('typescript'); const viteClient=ts.resolveTypeReferenceDirective('vite/client', require('node:path').resolve('src/env.d.ts'), {}, ts.sys).resolvedTypeReferenceDirective; if(!viteClient) throw new Error('vite/client is not resolvable from the web importer'); console.log('vite/client -> '+viteClient.resolvedFileName)"
RUN pnpm build

FROM manifests AS production-dependencies
RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
RUN pnpm install --prod --frozen-lockfile --filter emby-task-center

FROM node:24-bookworm-slim AS runtime
ARG BUILD_VERSION
ARG BUILD_REVISION=unknown
LABEL org.opencontainers.image.title="emby-task-center" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}"
ENV NODE_ENV=production \
    PORT=12333 \
    DATABASE_PATH=/data/emby-task-center.db \
    WEB_DIST_PATH=/app/public
WORKDIR /app
COPY --from=production-dependencies /workspace/node_modules ./node_modules
COPY --from=build /workspace/dist/server ./server
COPY --from=build /workspace/apps/web/dist ./public
COPY --from=build /workspace/packages/database/drizzle ./drizzle
RUN mkdir -p /data \
    && chown -R node:node /app /data
USER node
EXPOSE 12333
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'12333')+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server/index.mjs"]
