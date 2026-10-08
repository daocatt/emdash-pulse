# syntax=docker/dockerfile:1
#
# Suda Pulse —— Node.js standalone 站点镜像（三容器栈之一，见 docker-compose.yml）。
#
# 构建期只决定「适配器种类」（postgres + s3/local），**不含任何凭据**：
# 连接串与 S3 key 一律运行期从进程环境读取（见 astro.config.mjs 顶部说明）。
# 唯一需要在构建期给的值是 EMDASH_SITE_URL（用本地存储时影响图片优化）与
# S3_ENDPOINT（决定 storage 用 s3() 还是 local()）。

# ---- deps：安装依赖（含 npm workspaces 插件链接）----
FROM node:22-alpine AS deps
WORKDIR /app
# postinstall 会跑 scripts/patch-*.mjs 给上游插件打补丁，所以 scripts 要先就位。
COPY package.json package-lock.json ./
COPY plugins ./plugins
COPY scripts ./scripts
RUN npm ci

# ---- build：构建插件 + 站点 ----
FROM deps AS build
# 只传「种类」与站点 URL，不传凭据。
ARG S3_ENDPOINT=""
ARG EMDASH_SITE_URL=""
ARG SITE_THEME="news-factory"
ENV S3_ENDPOINT=$S3_ENDPOINT \
	EMDASH_SITE_URL=$EMDASH_SITE_URL \
	SITE_THEME=$SITE_THEME
COPY . .
RUN npm run build

# ---- runner：只带运行所需 ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=4321
# 依赖（含 pg / ioredis / aws-sdk / 各插件 dist）、构建产物、seed、脚本。
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/seed ./seed
COPY --from=build /app/scripts ./scripts
# 运行期数据目录：本地媒体（local 存储时）与会话（fsLite）。挂卷持久化。
RUN mkdir -p data/uploads data/sessions
EXPOSE 4321
CMD ["node", "./dist/server/entry.mjs"]
