# husky ставит git-хуки и в образе бесполезен: каталог .git сюда не копируется,
# а без HUSKY=0 скрипт prepare падает и ломает установку зависимостей.
ARG NODE_IMAGE=node:22-alpine

# --- Зависимости для сборки ------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV HUSKY=0

# Сначала только манифесты: слой с npm ci переиспользуется, пока они не менялись.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/proxmox/package.json packages/proxmox/package.json

# npm ci, а не npm install: версии берутся из локфайла и не разъезжаются между сборками.
RUN npm ci

# --- Сборка ----------------------------------------------------------------
FROM deps AS build
WORKDIR /app
ENV HUSKY=0
COPY tsconfig.json tsconfig.build.json ./
COPY apps apps
COPY packages packages
RUN npm run build

# --- Рантайм ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS server
WORKDIR /app
ENV NODE_ENV=production
ENV HUSKY=0

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/proxmox/package.json packages/proxmox/package.json

# Только рантайм-зависимости: typescript, eslint, vitest и semantic-release
# в продакшн-образе не нужны и весят больше самого приложения.
#
# --ignore-scripts обязателен вместе с --omit=dev: скрипт prepare зовёт husky,
# которого при пропуске devDependencies в образе нет, и npm падает с кодом 127.
# Переменная HUSKY=0 тут не помогает — её читает сам husky, а его уже не существует.
# Рантайм-зависимости чистые JS, нативных postinstall среди них нет.
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/proxmox/dist packages/proxmox/dist
COPY infra infra

# Сервер сам применяет миграции при старте, отдельный шаг не нужен.
CMD ["node", "apps/server/dist/index.js"]
