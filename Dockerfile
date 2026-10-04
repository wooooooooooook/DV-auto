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
COPY data/quiz.json ./data/quiz.json

RUN pnpm run build

RUN mkdir -p /app/runtime-data

ENV NODE_ENV=production
ENV TZ=Asia/Seoul
ENV HEADLESS=true
ENV SQLITE_DB_PATH=/app/runtime-data/app.db

CMD ["node", "dist/core/main.js"]
