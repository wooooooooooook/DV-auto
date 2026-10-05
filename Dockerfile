FROM node:24-bookworm

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

RUN pnpm exec playwright install --with-deps chromium

COPY tsconfig.json ./
COPY src ./src

RUN pnpm run build

# /app/data 는 컨테이너 recreate 시 비어 있는 상태로 부팅되며 startup hydration
# (services/git_sync.ts restoreDataFilesFromSyncRepo) 이 채운다. hydration 이 건너뛰어져도
# 족보 저장/삭제가 ENOENT 로 실패하지 않도록 디렉터리 자체는 이미지에 보장한다.
RUN mkdir -p /app/data /app/runtime-data

ENV NODE_ENV=production
ENV TZ=Asia/Seoul
ENV HEADLESS=true
ENV SQLITE_DB_PATH=/app/runtime-data/app.db

CMD ["node", "dist/core/main.js"]
