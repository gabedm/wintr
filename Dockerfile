FROM mirror.gcr.io/library/node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY scripts/ ./scripts/
COPY src/ ./src/
RUN VITE_HOSTED_ARTWORK=placeholder pnpm build && pnpm prune --prod --ignore-scripts

FROM mirror.gcr.io/library/node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY LICENSE ./LICENSE
USER node
EXPOSE 8080
CMD ["node", "dist/server/server/hosted-entry.js"]
