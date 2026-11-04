FROM node:24-bookworm

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# apt 설치 중 tzdata 등 대화형 프롬프트로 빌드가 멈추거나 실패하는 것을 방지
ENV DEBIAN_FRONTEND=noninteractive

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Chromium 시스템 의존성(apt)과 브라우저 다운로드를 분리한다.
# - 빌드 로그에서 어느 단계가 실패했는지 바로 알 수 있고,
# - apt 저장소/다운로드 CDN 의 일시 오류에 대비해 각각 재시도한다.
RUN set -eux; \
    df -h / || true; \
    pnpm exec playwright --version; \
    attempt=1; \
    while true; do \
      if pnpm exec playwright install-deps chromium; then break; fi; \
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
      if pnpm exec playwright install chromium; then break; fi; \
      if [ "$attempt" -ge 3 ]; then \
        echo "[build] chromium 다운로드 실패 (${attempt}회 시도)"; \
        exit 1; \
      fi; \
      attempt=$((attempt + 1)); \
      echo "[build] chromium 다운로드 재시도 ${attempt}"; \
      sleep 10; \
    done

ARG GIT_COMMIT=""
ARG GIT_COMMIT_DATE=""

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

RUN node scripts/generate-build-info.js "$GIT_COMMIT" "$GIT_COMMIT_DATE"
RUN pnpm run build

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
