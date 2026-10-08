# VPS 独立部署（Node + PostgreSQL + Redis + Docker）

> 结论先行：本站**不再部署在 Cloudflare Workers**。运行时是 **Node.js standalone**，
> 数据在自建 **PostgreSQL**，媒体在本地磁盘或任意 **S3 兼容**对象存储，对象缓存用
> **Redis**。三个容器（`pulse-app` / `pulse-db` / `pulse-redis`）由 `docker-compose.yml`
> 编排，TLS 由**宿主**上的反向代理终止。
>
> 本文是**运维手册**：首次部署、升级、备份、排障。架构背景见
> [02-architecture.md](./02-architecture.md)，选型依据见 [15-emdash-cloudflare-coupling.md](./15-emdash-cloudflare-coupling.md)。

---

## 1. 为什么离开 Cloudflare

| 驱动 | 说明 |
| --- | --- |
| **中文全文搜索** | EmDash 的 FTS 建在 SQLite FTS5 虚拟表上，**非 SQLite 方言直接抛错**。迁到 PG 后本站自建 `pulse_search` 表 + `pg_trgm` GIN 索引重建子串检索（见 §6），语义与原来的 trigram 分词器一致 |
| **AI 供应商自由** | 评论审核原先绑死 Workers AI。现在走插件 `pulse-ai`：Cloudflare AI Gateway / OpenAI / Anthropic / 任意 OpenAI 兼容端点，后台可切换，模型可换 |
| **数据自主** | 内容、订阅者、评论都在自己的 PG 里；媒体可落本地盘或自有对象存储 |
| **运维成本** | 一台 VPS + 三个容器即可，无按行计费的读/写配额（D1 免费层 2026-09 起改为**硬性失败**：超限当天后续查询全报错） |

代价（明确接受）：需要自己管主机、备份、TLS 证书与升级；失去边缘缓存（改用 Redis 对象缓存 + 反代缓存）。

---

## 2. 三容器拓扑

```
                    ┌────────────── 宿主 ──────────────┐
Internet ──TLS──▶  反向代理（Caddy / nginx）           │
                    │   127.0.0.1:4321                 │
                    └──────────┬───────────────────────┘
                               ▼
                    ┌──────────────────────┐
                    │  pulse-app           │  Node 22 · Astro SSR · 全部插件 in-process
                    │  (Dockerfile)        │  卷 pulse-data → /app/data（本地媒体 + 会话）
                    └───┬──────────────┬───┘
                        ▼              ▼
              ┌─────────────────┐  ┌──────────────────┐
              │  pulse-db       │  │  pulse-redis     │
              │  postgres:17    │  │  redis:7         │
              │  卷 pulse-db-data│  │  卷 pulse-redis-data│
              └─────────────────┘  └──────────────────┘
```

| 容器 | 镜像 | 作用 | 持久化 |
| --- | --- | --- | --- |
| `pulse-app` | 本仓库 `Dockerfile` | Astro SSR + EmDash + 8 个插件（同进程） | 卷 `pulse-data` → `/app/data` |
| `pulse-db` | `postgres:17-alpine` | 内容 / 用户 / 评论 / 订阅 / 插件存储 | 卷 `pulse-db-data` |
| `pulse-redis` | `redis:7-alpine` | EmDash 对象缓存后端 | 卷 `pulse-redis-data`（RDB 快照） |

容器名固定为 `pulse-app` / `pulse-db` / `pulse-redis`。**`pulse-app` 只绑 `127.0.0.1:4321`**，
不直接暴露到公网。

---

## 3. 首次部署

### 3.1 前置

- 一台 Linux VPS，装好 Docker + Docker Compose v2。
- 一个域名，A 记录指向该 VPS。
- 宿主的反向代理（Caddy 样例见 `deploy/Caddyfile.example`；nginx 等价配置要点也在该文件注释里）。

### 3.2 配置

```bash
git clone <repo> /srv/pulse && cd /srv/pulse
cp .env.example .env
```

必填项（其余见 `.env.example` 的逐项注释）：

| 变量 | 说明 |
| --- | --- |
| `EMDASH_ENCRYPTION_KEY` | 加密声明为 `secret` 的插件设置（Resend API key 等）。`npx emdash secret` 生成。**务必离线备份** —— 丢了它，已存的加密设置全部读不出来 |
| `EMDASH_SITE_URL` | 站点公开 origin（`https://pulse.example.com`）。Passkey / CSRF / MCP 发现 / sitemap / canonical 都依赖它 |
| `POSTGRES_PASSWORD` | 数据库密码（compose 用它拼出 `DATABASE_URL` 与 `PG*`） |
| `EMDASH_TRUSTED_PROXY_HEADERS` | 保持 `x-forwarded-for`，否则限流/订阅会按代理 IP 计数 |

选填：`S3_*`（媒体放对象存储）、`EMDASH_OAUTH_GITHUB_*`（GitHub 登录）、`SITE_THEME`（构建期默认主题）、`REDIS_URL`（本地 dev 用）。

### 3.3 启动

```bash
npm run docker:up     # = docker compose up -d --build
```

首次构建会跑 `npm ci`（含 `postinstall` 的两个上游补丁）→ `plugin:build` → `astro build`。
`pulse-db` 首次初始化时会执行 `docker/initdb/00-extensions.sql`（建 `pg_trgm` 扩展）。

启动后容器内会自动：迁移库（EmDash）→ 尽力预热搜索索引（`scripts/search-rebuild.mjs || true`）→ `node ./dist/server/entry.mjs`。

### 3.4 反向代理与 TLS

把 `deploy/Caddyfile.example` 的站点块并入宿主 Caddyfile（改域名）后 reload。Caddy 会自动申请证书。
nginx 要点：`proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme;`

### 3.5 初始化站点

1. 打开 `https://<域名>/_emdash/admin` → 走 **setup 向导**：站点标题、管理员邮箱、注册第一个 **Passkey**，并导入 `seed/seed.json`（示例内容 + 媒体，可能几分钟）。
2. 后台 → **Resend** 页 → 填 API Key 与 From 地址。没有它，邮箱 magic link 登录会 `503 EMAIL_NOT_CONFIGURED`，订阅确认信只能落库待发。
3. *可选* 后台 → **AI 网关** 页 → 选 provider、填凭据 → 点「测试连接」。评论审核会用它（未配置时降级为纯规则引擎，不自动放行）。
4. *可选* 后台 → **订阅群发** 页 + 在 Resend 后台配 Webhook（见 §7）。

---

## 4. 环境变量与构建期/运行期的分界

这是最容易踩的坑：**EmDash 把 `database` / `storage` / `objectCache` 描述符序列化进产物**
（`virtual:emdash/config`），所以连接串**不能**写在 `astro.config.mjs` 里，否则会被烘进镜像。

`astro.config.mjs` 因此遵守「**构建期只选种类，凭据一律运行期读 env**」：

| 关注点 | 构建期决定 | 运行期读取 |
| --- | --- | --- |
| 数据库 | `postgres()`（固定） | `pg` 连接池读 `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD`；迁移工具读 `DATABASE_URL` |
| 存储 | `S3_ENDPOINT` 非空 → `s3()`，否则 `local()` | `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_REGION` / `S3_PUBLIC_URL` |
| 对象缓存 | entrypoint 与可序列化默认值 | `REDIS_URL` |
| 图片白名单 | `EMDASH_SITE_URL`（+ `S3_PUBLIC_URL`）进 `image.remotePatterns` | — |

所以 `Dockerfile` 只把 `S3_ENDPOINT` / `EMDASH_SITE_URL` / `SITE_THEME` 作为**构建参数**传入，
凭据全部在 `docker-compose.yml` 的 `environment` 里运行期注入。

> 换域名：只改 `.env` 的 `EMDASH_SITE_URL` 并**重新构建**（它会进 `remotePatterns`），无需改源码。

---

## 5. 日常运维

```bash
npm run docker:up              # 构建并启动 / 应用新配置
npm run docker:down            # 停栈（保留卷）
docker compose logs -f pulse-app
docker compose restart pulse-app
npm run search:rebuild         # 手动重建搜索索引（见 §6）
```

### 升级流程

```bash
git pull
npm run docker:up              # 重新构建 pulse-app；启动时自动跑迁移
```

镜像重建后 `pulse-app` 的启动命令会先跑迁移再起服务。**升级前先备份**（§8）。

### 本地开发（不走 Docker）

```bash
# .env 里配 DATABASE_URL 或 PG*，指向本机 PG；REDIS_URL 可选
npm run dev                    # 构建插件 + Astro dev（Node，非 Workers）
npm run typecheck:all          # 两套主题各跑一次 astro check
npm run plugin:build           # 改了插件必须重建（astro.config 导入的是 dist/*.mjs）
```

---

## 6. 搜索（`pg_trgm`）

EmDash 的 FTS 只支持 SQLite。PG 上本站自建：

- 表 `pulse_search`（文档正文的纯文本 + 元数据），GIN **trigram** 索引（`pg_trgm`）。
- 代码在 `src/server/search-index.mjs`：**自有 `pg` 连接池**（不依赖 EmDash 的 Kysely 句柄），
  `ensureAndRefreshIndex()` 首次调用建表建索引并同步一次，之后按 `TTL_MS`（5 分钟）节流刷新；
  用 PG **advisory lock** 防并发重建；**任何异常都降级**（空结果 / 跳过刷新），绝不让搜索拖垮页面。
- `scripts/search-rebuild.mjs`（`npm run search:rebuild`）手动重建，容器启动时也会尽力跑一次。

**重建库后必须重跑**（`pg_trgm` 扩展由 `docker/initdb/00-extensions.sql` 建，只在空数据目录上执行一次；
已有数据的库请手动 `CREATE EXTENSION IF NOT EXISTS pg_trgm;`）。

---

## 7. 邮件与订阅（Resend）

- 传输层是 `emdash-plugin-resend`（独占 `email:deliver`），API key / From 在后台 **Resend** 页填写（加密存储）。
- `pulse-subscriptions` 把**订阅分组同步为 Resend Segments**，**群发走 Resend Broadcasts**：
  后台 **订阅群发** 页选分组 + 主题 + HTML → `POST /broadcasts`（`send: true`）。
  收件人池由 Resend 按 segment 展开，自动插入退订链接、跳过已退订联系人。
- **投递回执**：在 Resend 后台配 Webhook，地址
  `https://<域名>/_emdash/api/plugins/pulse-subscriptions/resend/webhook`，
  事件勾选 `email.delivered` / `bounced` / `complained` / `opened` / `clicked`。
  把它的 **Svix 签名密钥**（`whsec_…`）填到后台 **订阅** 设置页的「Resend Webhook 签名密钥」。
  留空时该路由返回 `503`（而不是静默 200），避免「Resend 显示已投递、本地却永远收不到回执」。

回执只写事件日志，**不会自动改订阅状态** —— 软退信不等于读者不想收，处置交人工。

---

## 8. 备份与恢复

要备份三样：**PG 数据**、**`pulse-data` 卷**（本地媒体 + 会话）、**`EMDASH_ENCRYPTION_KEY`**。

```bash
# PostgreSQL（逻辑备份）
docker compose exec pulse-db pg_dump -U "${POSTGRES_USER:-pulse}" "${POSTGRES_DB:-pulse}" > backup-$(date +%F).sql

# 本地媒体 / 会话卷
docker run --rm -v pulse-data:/data -v "$PWD":/out alpine \
  tar czf /out/pulse-data-$(date +%F).tgz -C /data .

# 恢复
docker compose exec -T pulse-db psql -U "${POSTGRES_USER:-pulse}" "${POSTGRES_DB:-pulse}" < backup-YYYY-MM-DD.sql
docker run --rm -v pulse-data:/data -v "$PWD":/out alpine tar xzf /out/pulse-data-YYYY-MM-DD.tgz -C /data
```

> 用了 S3 存媒体就跳过卷备份，改备份桶。
> **`EMDASH_ENCRYPTION_KEY` 必须单独妥善保管**：它不在数据库里，丢了就无法解密已存的插件密钥。

---

## 9. 排障

| 症状 | 排查 |
| --- | --- |
| 容器起来就退出 | `docker compose logs pulse-app`；多为 `EMDASH_SITE_URL` 未设或 DB 连不上 |
| 图片在**生产**退回原图（srcset 各档位同一张） | `EMDASH_SITE_URL` / `S3_PUBLIC_URL` 没进构建期 → 重新构建（§4） |
| 搜索无结果 | `npm run search:rebuild`；确认 `pg_trgm` 扩展存在 |
| 限流按代理 IP 计 | `.env` 里 `EMDASH_TRUSTED_PROXY_HEADERS=x-forwarded-for`，且反代透传 `X-Forwarded-For` |
| Passkey 登录失败 | `EMDASH_SITE_URL` 与实际访问 origin 不一致（https / 域名 / 端口） |
| 插件设置读不出（API key 失效） | `EMDASH_ENCRYPTION_KEY` 变了或被清空 |
| 后台某页 502 `INVALID_BLOCK_RESPONSE` | 插件的 Block Kit 用了非法块/元素类型或 camelCase 字段名；改完 `npm run plugin:build` |

---

## 10. 与 Cloudflare 的关系

代码里仍保留**可选的** S3 兼容对象存储支持（R2 是 S3 兼容的），所以媒体可以继续放 R2 —— 但
**运行时、数据库、缓存、AI、定时任务都不再依赖 Cloudflare**。定时发布（cron）现在由 Node 进程内的
调度器承担，不再依赖 Workers cron trigger。
