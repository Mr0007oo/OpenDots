FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS production-deps
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATABASE_PATH=/data/opendots.sqlite
WORKDIR /app
COPY package.json ./
COPY --from=production-deps /app/node_modules ./node_modules
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4310
CMD ["node", "dist/server/server/index.js"]

FROM node:24-bookworm-slim AS browser
ENV NODE_ENV=production BROWSER_HOST=0.0.0.0 BROWSER_PORT=4311 OBSCURA_CDP_URL=ws://127.0.0.1:9222
WORKDIR /app
COPY package.json ./
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist/server ./dist/server
USER node
EXPOSE 4311
CMD ["node", "dist/server/browser/index.js"]
