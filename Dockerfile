# Multi-stage: build TS with dev deps, ship a lean runtime.
# @reckon/core is vendored as reckon-core-*.tgz (dep-free), so the image is self-contained.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
# probot listens for GitHub webhooks directly on $PORT (no smee in prod).
CMD ["npm", "start"]
