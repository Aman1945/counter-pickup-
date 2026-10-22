# Stage 1: build the customer screen (React + Vite) into static files.
FROM node:24-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# Stage 2: the API. Node 24 runs the TypeScript directly (type stripping), so there is no build step.
FROM node:24-alpine
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY api/src ./src
COPY api/test ./test
COPY api/scripts ./scripts
COPY --from=web /web/dist ./web-dist
EXPOSE 3000
CMD ["node", "src/main.ts"]
