# ---- Stage 1: Dependencies ----
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
COPY apps/frontend/package.json ./apps/frontend/

RUN corepack enable && yarn install --immutable

# ---- Stage 2: Build ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN yarn workspace frontend build

# ---- Stage 3: Production (nginx) ----
FROM nginx:alpine AS production
COPY --from=builder /app/dist/apps/frontend /usr/share/nginx/html
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

# ---- Stage 4: Development (default) ----
FROM node:20-alpine AS development
WORKDIR /app

RUN corepack enable

COPY .yarnrc.yml ./
COPY package.json yarn.lock ./
COPY apps/frontend/package.json ./apps/frontend/

RUN yarn install --immutable

COPY . .

WORKDIR /app/apps/frontend
EXPOSE 5173

CMD ["yarn", "dev"]
