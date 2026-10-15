FROM node:24-bookworm

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

RUN pnpm exec playwright install --with-deps chromium

ARG GIT_COMMIT=""
ARG GIT_COMMIT_DATE=""

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY .git ./.git

RUN node scripts/generate-build-info.js "$GIT_COMMIT" "$GIT_COMMIT_DATE" && \
    rm -rf .git

RUN pnpm run build && cp build-info.json dist/build-info.json

# /app/data 는 컨테이너 recreate 시 비어 있는 상태로 부팅되며 startup hydration
# (services/git_sync.ts restoreDataFilesFromSyncRepo) 이 채운다. hydration 이 건너뛰어져도
# 족보 저장/삭제가 ENOENT 로 실패하지 않도록 디렉터리 자체는 이미지에 보장한다.
RUN mkdir -p /app/data /app/runtime-data

ENV NODE_ENV=production
ENV TZ=Asia/Seoul
ENV HEADLESS=true
ENV SQLITE_DB_PATH=/app/runtime-data/app.db
ENV GIT_COMMIT=${GIT_COMMIT}
ENV GIT_COMMIT_DATE=${GIT_COMMIT_DATE}

CMD ["node", "dist/core/main.js"]
