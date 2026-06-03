# syntax=docker/dockerfile:1
# Build casey, then run it as a small production image.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Tickets + conversations persist here — mount a volume at /root/.casey.
EXPOSE 8787
ENTRYPOINT ["node", "dist/cli.js"]
# Default: web chat widget + universal webhook. Override the command to add
# --slack / --discord / --teams / --arnie-queue. Point at the model with
# ANTHROPIC_API_KEY (+ ANTHROPIC_BASE_URL to route through a dario proxy).
CMD ["serve", "--web", "--port", "8787"]
