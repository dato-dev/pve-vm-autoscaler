FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json tsconfig.json tsconfig.build.json eslint.config.js ./
COPY apps/server/package.json apps/server/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/proxmox/package.json packages/proxmox/package.json

RUN npm install

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM node:22-alpine AS server
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/server /app/apps/server
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/packages/proxmox /app/packages/proxmox
COPY --from=build /app/infra /app/infra

CMD ["node", "apps/server/dist/index.js"]
