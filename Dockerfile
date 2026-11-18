# ---- 공통 베이스 (빌드 도구 포함) ----
FROM node:24-bookworm AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# apt 설치 중 tzdata 등 대화형 프롬프트로 빌드가 멈추거나 실패하는 것을 방지
ENV DEBIAN_FRONTEND=noninteractive

RUN corepack enable

WORKDIR /app

# ---- 빌드용 의존성 (devDependencies 포함) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- TypeScript 빌드 ----
FROM deps AS build
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

ARG GIT_COMMIT=""
ARG GIT_COMMIT_DATE=""

RUN node scripts/generate-build-info.js "$GIT_COMMIT" "$GIT_COMMIT_DATE"
RUN pnpm run build

# ---- 운영 의존성만 설치 (네이티브 모듈은 빌드 도구가 있는 base 에서 준비) ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- 런타임 이미지 ----
# slim 베이스 + 운영 의존성 + Chromium 만 포함한다.
# devDependencies/typescript/빌드 도구가 빠져 이미지가 작아지고, 디스크 여유가 작은 서버에서도 pull 할 수 있다.
FROM node:24-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# TZ 처리를 위한 tzdata, CA 인증서, git 동기화를 위한 git (slim 에는 포함되어 있지 않다)
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends tzdata ca-certificates git; \
    rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/node_modules ./node_modules

# Chromium 시스템 의존성(apt)과 브라우저 다운로드를 분리한다.
# - 빌드 로그에서 어느 단계가 실패했는지 바로 알 수 있고,
# - apt 저장소/다운로드 CDN 의 일시 오류에 대비해 각각 재시도한다.
RUN set -eux; \
    df -h / || true; \
    attempt=1; \
    while true; do \
      if ./node_modules/.bin/playwright install-deps chromium; then break; fi; \
      if [ "$attempt" -ge 3 ]; then \
        echo "[build] playwright install-deps 실패 (${attempt}회 시도)"; \
        exit 1; \
      fi; \
      attempt=$((attempt + 1)); \
      echo "[build] playwright install-deps 재시도 ${attempt}"; \
      sleep 10; \
    done; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

RUN set -eux; \
    attempt=1; \
    while true; do \
      if ./node_modules/.bin/playwright install chromium; then break; fi; \
      if [ "$attempt" -ge 3 ]; then \
        echo "[build] chromium 다운로드 실패 (${attempt}회 시도)"; \
        exit 1; \
      fi; \
      attempt=$((attempt + 1)); \
      echo "[build] chromium 다운로드 재시도 ${attempt}"; \
      sleep 10; \
    done

COPY --from=build /app/dist ./dist
COPY --from=build /app/build-info.json ./build-info.json

# /app/data 는 컨테이너 recreate 시 비어 있는 상태로 부팅되며 startup hydration
# (services/git_sync.ts restoreDataFilesFromSyncRepo) 이 채운다. hydration 이 건너뛰어져도
# 족보 저장/삭제가 ENOENT 로 실패하지 않도록 디렉터리 자체는 이미지에 보장한다.
RUN mkdir -p /app/data /app/runtime-data

ENV NODE_ENV=production
ENV TZ=Asia/Seoul
ENV HEADLESS=true
ENV SQLITE_DB_PATH=/app/runtime-data/app.db

CMD ["node", "dist/core/main.js"]
