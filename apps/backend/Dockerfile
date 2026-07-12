# ---- Stage 1: Dependencies ----
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
COPY apps/backend/package.json ./apps/backend/

RUN corepack enable && yarn install --immutable

# ---- Stage 2: Build ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN yarn workspace backend build

# ---- Stage 3: Production ----
FROM node:20-alpine AS production
WORKDIR /app

# ---------------------------------------------------------------------------
# MCP Server Dependencies
# ---------------------------------------------------------------------------
# kubectl: required by @flux159/mcp-server-kubernetes + kubetail-mcp for K8s access
# MCP server packages are installed globally so npx/uvx finds them without download
RUN apk add --no-cache kubectl curl python3 py3-pip && \
    pip install --break-system-packages uv && \
    uv tool install kubetail-mcp && \
    npm install -g \
      @flux159/mcp-server-kubernetes \
      @awslabs/amazon-cloudwatch-logs-mcp \
      @swen128/cloud-logging-mcp

COPY --from=builder /app/dist/apps/backend ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/backend/package.json ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/main"]

# ---- Stage 4: Development (default) ----
FROM node:20-alpine AS development
WORKDIR /app

RUN corepack enable

COPY .yarnrc.yml ./
COPY package.json yarn.lock ./
COPY apps/backend/package.json ./apps/backend/

RUN yarn install --immutable

COPY . .

WORKDIR /app/apps/backend
EXPOSE 3000

CMD ["yarn", "dev"]
