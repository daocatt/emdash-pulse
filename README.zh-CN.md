# Suda Pulse

[English](./README.md) · **简体中文**

基于 [EmDash](https://github.com/emdash-cms/emdash) + [Astro](https://astro.build/) 构建的 **Agent 协作新闻室发布系统**。

Suda Pulse 是一套面向新闻编辑室、报刊与独立媒体的全栈发布系统，以 AI agent 协作为核心。它自带两套可切换的前台主题、编审工作流、多用户后台、面向 author/editor agent 的 MCP 接口，以及面向 reader agent 的机器可读阅读 API。运行时是**独立的 VPS 部署** —— 三个 Docker 容器，不依赖任何托管平台。

---

## 功能

- **两套前台主题** —— `news-factory`（报纸头版）与 `pulse-news`（杂志）。默认主题由构建期 `SITE_THEME` 决定；编辑可在后台**运行期切换**，无需重新部署。
- **多用户 RBAC** —— EmDash 内置五个角色（Subscriber → Contributor → Author → Editor → Admin），支持 Passkey 登录。
- **编审工作流** —— 草稿 → 待审 → 通过 / 驳回 → 发布或定时发布；作者投稿一律强制审核后才上线。
- **Agent 新闻室** —— 编辑分发选题，author agent 领取并投稿，editor agent（或人工）审核并发布。
- **MCP 服务** —— `POST /_emdash/api/mcp`，走 EmDash 原生 OAuth 2.1（授权码 + PKCE、device grant）或个人访问令牌；token 的 scope 与用户角色取交集。
- **Agent Read API** —— `/agent/*` 下的公开、限流 JSON 端点（新闻、版块、期号、JSON Feed、schema）以及 `/llms.txt`。
- **评论** —— 内置评论 + 规则引擎与 AI 语义审核，模型调用走 `pulse-ai` 插件。
- **邮件订阅** —— 双确认、退订、订阅者分组与事件日志；通过 [Resend](https://resend.com/) 投递。分组同步为 Resend **Segments**，群发走 Resend **Broadcasts**，投递回执走签名 **Webhook**。
- **SEO 与订阅源** —— JSON-LD、XML sitemap、`robots.txt`、RSS 与 JSON Feed。
- **双语界面** —— zh-CN / en 运行期切换（内容本身不翻译）。
- **媒体管线** —— 图片存于本地磁盘或任意 S3 兼容存储，支持响应式 `srcset`、WebP 与 LQIP。
- **归档与搜索** —— 按月 / 周浏览；全文搜索由 PostgreSQL `pg_trgm` 支撑。
- **第三方编辑** —— GitHub 登录 + `/editor/apply` 申请页 + 后台审批队列。
- **定时发布** —— 进程内调度器驱动定时稿件。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Astro 7（`output: "server"`，SSR） |
| CMS | [EmDash](https://github.com/emdash-cms/emdash) 1.2 |
| 运行时 | Node.js 22（`@astrojs/node`，standalone） |
| 数据 | PostgreSQL 17 |
| 缓存 | Redis 7（EmDash 对象缓存） |
| 媒体 | 本地磁盘或 S3 兼容（R2 / MinIO / …） |
| AI | `pulse-ai` —— Cloudflare AI Gateway / OpenAI / Anthropic / 任意 OpenAI 兼容端点 |
| 交互岛 | React 19 |
| 语言 | TypeScript |
| 扩展 | 8 个自研插件（全部 in-process） |
| 打包 | Docker Compose —— `pulse-app` / `pulse-db` / `pulse-redis` |

## 本地快速开始

要求：**Node 22.16+**，以及一个可达的 **PostgreSQL**（Redis 可选 —— 未配置时对象缓存自动降级为直通）。

```bash
npm install                       # 同时会对两个上游插件包打小补丁（见「说明」）

# 最省事：只用 compose 起数据服务
docker compose up -d pulse-db pulse-redis

cp .env.example .env              # 填 EMDASH_ENCRYPTION_KEY 与 PG*/DATABASE_URL
npm run dev                       # 构建插件后启动 Astro dev，地址 http://localhost:4321
```

- 内容在 PostgreSQL；本地媒体落 `./uploads`，会话落 `./data/sessions`。
- 后台：<http://localhost:4321/_emdash/admin>。首次访问会走 **setup 向导** —— 站点标题/副标题、管理员邮箱、注册 Passkey，并导入 `seed/seed.json`（示例内容 + 媒体，可能需要几分钟）。
- 改构建期默认主题：`SITE_THEME=pulse-news npm run dev`。
- 重建过数据库后需要重跑搜索索引：`npm run search:rebuild`。

## 部署到 VPS

应用以三个 Docker 容器运行，由 `docker-compose.yml` 编排；TLS 由宿主上的反向代理终止。仓库**不保存任何凭据** —— 全部走 git 忽略的 `.env`（模板 `.env.example`）。

**完整运维手册见 [`docs/16-vps-deployment.md`](./docs/16-vps-deployment.md)。** 速览：

### 1. 配置

```bash
git clone <repo> /srv/pulse && cd /srv/pulse
cp .env.example .env
```

必填：`EMDASH_ENCRYPTION_KEY`（加密落库的插件密钥 —— **务必备份**，丢了它已存的密钥就解不开）、`EMDASH_SITE_URL`（公开 origin）、`POSTGRES_PASSWORD`，以及 `EMDASH_TRUSTED_PROXY_HEADERS=x-forwarded-for`（让限流/订阅拿到真实客户端 IP）。可选：`S3_*`（对象存储）、`EMDASH_OAUTH_GITHUB_*`（GitHub 登录）、`SITE_THEME`。

### 2. 启动

```bash
npm run docker:up     # = docker compose up -d --build
```

它会构建 `pulse-app`（插件 → Astro 构建）、起 `pulse-db` 与 `pulse-redis`，并在启动时自动跑迁移。`pulse-db` 首次初始化时会建 `pg_trgm` 扩展（`docker/initdb/00-extensions.sql`）。

### 3. 反向代理

把 [`deploy/Caddyfile.example`](./deploy/Caddyfile.example) 的站点块并入宿主 Caddyfile 后 reload —— Caddy 会自动申请证书。`pulse-app` 只绑 `127.0.0.1:4321`。nginx 等价配置要点在同一文件里。

### 4. 首次启动之后

1. 打开 `https://<你的域名>/_emdash/admin` 走完 **setup 向导** —— 它会灌入内容并注册首个管理员 Passkey。
2. 后台 → **Resend** 页 → 填 API key 与 From 地址。缺它时邮箱链接登录（magic link）返回 `503 EMAIL_NOT_CONFIGURED`，订阅邮件只能落库待发。
3. *可选* —— 后台 → **AI 网关** 页 → 选 provider、填凭据、点「测试连接」。
4. *可选* —— 配置 Resend Webhook 收投递回执（见 `docs/16-vps-deployment.md` §7）。

### 构建期 vs 运行期的分界

EmDash 会把 `database` / `storage` / `objectCache` 描述符序列化进构建产物，所以连接串**绝不能**出现在 `astro.config.mjs` 里。配置里只决定适配器的**种类**，凭据一律运行期从环境读。

| 关注点 | 构建期决定 | 运行期读取 |
| --- | --- | --- |
| 数据库 | `postgres()`（固定） | `pg` 连接池读 `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD`；迁移读 `DATABASE_URL` |
| 存储 | `S3_ENDPOINT` 非空 → `s3()`，否则 `local()` | `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_REGION` / `S3_PUBLIC_URL` |
| 对象缓存 | entrypoint + 可序列化默认值 | `REDIS_URL` |
| 图片白名单 | `EMDASH_SITE_URL`（+ `S3_PUBLIC_URL`） | — |

因此**换域名**只需改 `EMDASH_SITE_URL` 并重新构建，无需动源码。

## 配置项

| 变量 | 作用 | 是否必需 |
| --- | --- | --- |
| `EMDASH_ENCRYPTION_KEY` | 加密落库的插件密钥 | **必需** |
| `EMDASH_SITE_URL` | 公开 origin（Passkey、CSRF、MCP 发现、sitemap、JSON-LD、图片白名单） | **生产必需** |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | 数据库凭据（compose 据此拼出 `DATABASE_URL` 与 `PG*`） | **必需** |
| `DATABASE_URL` | `emdash` CLI / 迁移用的单条连接串 | 二选一 |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | 运行期连接池读的标准 libpq 变量 | 二选一 |
| `REDIS_URL` | EmDash 对象缓存后端；未设置时缓存直通 | 否 |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_REGION` / `S3_PUBLIC_URL` | S3 兼容媒体存储（构建期设了 `S3_ENDPOINT` 才会选 `s3()`） | 否 |
| `SITE_THEME` | 构建期默认主题（`news-factory` \| `pulse-news`） | 否（默认 `news-factory`） |
| `EMDASH_OAUTH_GITHUB_CLIENT_ID` / `EMDASH_OAUTH_GITHUB_CLIENT_SECRET` | GitHub 登录 | 否 |
| `EMDASH_TRUSTED_PROXY_HEADERS` | 信任代理头，让限流拿到真实客户端 IP | 建议 |

## 脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 构建插件后启动 Astro dev（连 PostgreSQL） |
| `npm run build` | 构建插件 + 默认主题的 Node 产物 |
| `npm run build:news-factory` / `build:pulse-news` | 构建指定主题 |
| `npm run docker:up` / `docker:down` | 构建并启动 / 停止三容器栈 |
| `npm run start` | 跑构建后的 Node 产物（`dist/server/entry.mjs`） |
| `npm run typecheck` / `typecheck:all` | 单套 / 两套主题 `astro check` |
| `npm run plugin:build` / `plugin:test` | 构建 / 测试全部插件 |
| `npm run search:rebuild` | 重建 `pulse_search` 索引（`pg_trgm`） |
| `npm run demo:data` | 灌入本地 Demo 互动数据（`:clean` 清理） |
| `npm run perf` | 两套主题的移动端 Lighthouse 复核 |

## 主题

| 主题 | 风格 | 目录 |
| --- | --- | --- |
| `news-factory` | 报纸头版（深红、细横线、三栏） | `src/themes/news-factory/` |
| `pulse-news` | 杂志式（米白纸色、大留白、作者卡） | `src/themes/pulse-news/` |

主题不是 `src/pages/` 下的文件路由，而是由 `astro.config.mjs` 的 `THEME_ROUTES` 注入。默认主题注册在干净路径上，另一套在 `/_t/<theme>/…`，由 `src/middleware.ts` 按后台设置做请求期 rewrite。

## Agent 与 MCP

Suda Pulse 提供两个 agent 面：

- **写侧（MCP）** —— `POST /_emdash/api/mcp`。Author agent 自助注册并拿到 scoped token；editor agent 是持有 Editor 角色的 EmDash 用户，其 MCP 客户端走原生 OAuth 以该用户身份连接、自动继承能力。**没有「agent 角色」这回事**。
- **读侧（HTTP JSON）** —— 公开、限流的端点：`/agent/news`、`/agent/news/[slug]`、`/agent/news/latest`、`/agent/sections`、`/agent/editions`、`/agent/feed.json`、`/agent/schema`。

详见 [`docs/09-agent-newsroom.md`](./docs/09-agent-newsroom.md) 与 [`docs/06-mcp-agents.md`](./docs/06-mcp-agents.md)。

## 文档

规划与参考文档在 [`docs/`](./docs/README.md)（中文）：架构、内容模型、前台主题、后台审核、MCP、插件、路线图、运营手册与实施报告。部署请先看 [`docs/16-vps-deployment.md`](./docs/16-vps-deployment.md)。

## 说明

`postinstall` 会对两个上游插件包打小补丁（`scripts/patch-audit-log.mjs`、`scripts/patch-resend.mjs`），让它们适配当前钉住的 EmDash 版本；上游修复后自动跳过（幂等）。

## 许可

[MIT](./LICENSE) © 2026 daocatt
