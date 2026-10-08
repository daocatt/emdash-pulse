# Suda Pulse

[English](./README.md) · **简体中文**

基于 [EmDash](https://github.com/emdash-cms/emdash) + [Astro](https://astro.build/) 构建的 **Agent 协作新闻室发布系统**。

Suda Pulse 是一套面向新闻编辑室、报刊与独立媒体的全栈发布系统，以 AI agent 协作为核心。它自带两套可切换的前台主题、编审工作流、多用户后台、面向 author/editor agent 的 MCP 接口，以及面向 reader agent 的机器可读阅读 API。

---

## 功能

- **两套前台主题** —— `news-factory`（报纸头版）与 `pulse-news`（杂志）。默认主题由构建期 `SITE_THEME` 决定；编辑可在后台**运行期切换**，无需重新部署。
- **多用户 RBAC** —— EmDash 内置五个角色（Subscriber → Contributor → Author → Editor → Admin），支持 Passkey 登录。
- **编审工作流** —— 草稿 → 待审 → 通过 / 驳回 → 发布或定时发布；作者投稿一律强制审核后才上线。
- **Agent 新闻室** —— 编辑分发选题，author agent 领取并投稿，editor agent（或人工）审核并发布。
- **MCP 服务** —— `POST /_emdash/api/mcp`，走 EmDash 原生 OAuth 2.1（授权码 + PKCE、device grant）或个人访问令牌；token 的 scope 与用户角色取交集。
- **Agent Read API** —— `/agent/*` 下的公开、限流 JSON 端点（新闻、版块、期号、JSON Feed、schema）以及 `/llms.txt`。
- **评论** —— 内置评论 + 规则引擎与 Cloudflare Workers AI 语义审核。
- **邮件订阅** —— 双确认、退订、订阅者分组与事件日志；通过 [Resend](https://resend.com/) 投递。
- **SEO 与订阅源** —— JSON-LD、XML sitemap、`robots.txt`、RSS 与 JSON Feed。
- **双语界面** —— zh-CN / en 运行期切换（内容本身不翻译）。
- **媒体管线** —— 图片存于 R2，支持响应式 `srcset`、WebP 与 LQIP。
- **归档与搜索** —— 按月 / 周浏览；全文搜索。
- **第三方编辑** —— GitHub 登录 + `/editor/apply` 申请页 + 后台审批队列。
- **定时发布** —— cron 触发器驱动定时稿件。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Astro 7（`output: "server"`，SSR） |
| CMS | [EmDash](https://github.com/emdash-cms/emdash) 1.2 |
| 运行时 | Cloudflare Workers |
| 数据 | Cloudflare D1（内容） |
| 媒体 | Cloudflare R2 |
| AI | Cloudflare Workers AI（评论审核） |
| 交互岛 | React 19 |
| 语言 | TypeScript |
| 扩展 | 7 个自研插件（全部 in-process） |

## 本地快速开始

要求：**Node 22.16+**。

```bash
npm install     # 同时会对两个上游插件包打小补丁（见「说明」）
npm run dev     # 构建插件后启动 Astro dev，地址 http://localhost:4321
```

- 本地数据落在 SQLite（`data.db`）与 `./uploads`。
- 后台：<http://localhost:4321/_emdash/admin>。首次访问会走 **setup 向导** —— 站点标题/副标题、管理员邮箱、注册 Passkey，并导入 `seed/seed.json`（示例内容 + 媒体，可能需要几分钟）。
- 改构建期默认主题：`SITE_THEME=pulse-news npm run dev`。

## 部署到 Cloudflare

应用运行在 Cloudflare Workers 上，使用 D1、R2 与 Workers AI。仓库**不保存任何账号信息**：提交的 `wrangler.jsonc` 与各 `*.example` 文件只有占位符，真实值放在 git 忽略的 `wrangler.prod.jsonc` 与 `.env.deploy`。

### Workers 计划：免费 vs 付费

**默认配置完全可以在 Workers 免费计划上运行。** 七个插件全部 **in-process**（`plugins: []`），涉及的 Cloudflare 产品只有 D1、R2、Workers AI 与 cron —— 都有免费额度。若预期高流量，请以 Cloudflare 当前限额为准。

**只有想启用 isolate 级插件沙箱时才需要 Workers 付费计划。** Workers 上唯一的沙箱后端是 **Worker Loader**（`LOADER` 绑定），属付费能力。免费计划下切到 `sandboxed: []`，`@emdash-cms/cloudflare` 的 `sandbox()` 读不到绑定会返回 `undefined`，**所有沙箱插件静默不加载**（构建期只打一条 warn）。本地逃生舱 `sandbox: false` 在 Workers 上被运行时显式禁用。

| | 免费计划 | 付费计划 |
| --- | --- | --- |
| In-process 插件（`plugins: []`，默认） | ✅ | ✅ |
| D1 · R2 · Workers AI · cron | ✅（免费额度） | ✅ |
| 沙箱插件（`sandboxed: []` + `LOADER`） | ❌ | ✅ |

### 1. 创建 D1 数据库

```bash
npx wrangler d1 create suda-pulse-db
```

记下返回的 `database_id`。（R2 桶由部署脚本自动创建。）

### 2. 配置

```bash
cp wrangler.prod.jsonc.example wrangler.prod.jsonc
```

填写：

- `account_id` —— 你的 Cloudflare 账号 ID（出现在每次控制台 URL 里）。
- `d1_databases[0].database_id` —— 上一步拿到的值。
- `routes[0].pattern` —— 你的自定义域名，如 `pulse.example.com`，且该 zone 必须已在同一账号下托管。想先快速验证，可注释掉 `routes`，改用 `suda-pulse.<你的子域>.workers.dev`。
- `vars.EMDASH_SITE_URL` —— 公开 origin，如 `https://pulse.example.com`。**必填**：Passkey、CSRF、MCP 发现、sitemap 与 JSON-LD 都依赖它，缺它时 setup 向导会返回 `500 SITE_URL_REQUIRED`。部署脚本也会把它传给构建，保证图片域名白名单正确。

再创建本地 env 文件：

```bash
cp .env.deploy.example .env.deploy   # 可选：把 WRANGLER_HOME 指向某个 wrangler 登录目录
cp .env.example .env                 # 填 EMDASH_ENCRYPTION_KEY
```

- `EMDASH_ENCRYPTION_KEY` 用于加密落库的插件密钥（API key 等）。用 `npx emdash secret` 生成。**务必备份** —— 换值会让此前加密落库的设置再也解不开。
- `WRANGLER_HOME` 让你用指定的 `wrangler login` 凭据部署（把 `HOME` 指向该账号目录），适合手上有多个 Cloudflare 账号时。留空则用当前 shell 的登录态。

### 3. 部署

```bash
npm run deploy:cf
```

脚本按顺序执行：`wrangler whoami`（仅提示）→ 幂等创建 R2 桶 → 补写缺失的 Worker secret → 构建插件 → 用 Cloudflare 适配器 `astro build` → `wrangler deploy`。

可用开关：`--skip-build`、`--no-secrets`、`--no-buckets`。

**更简单的路径：** `npm run deploy` 跳过辅助脚本，直接用当前 shell 已登录的 wrangler 凭据（`wrangler login`）部署。

### 4. 首次部署之后

1. 打开 `https://<你的域名>/_emdash/admin` 走完 **setup 向导** —— 它会灌入内容并注册首个管理员 Passkey。（超级管理员无法用配置预指定，只能由向导的 WebAuthn 注册写入。）
2. 后台 → **Resend** 页 → 填 API key 与 From 地址。缺它时邮箱链接登录（magic link）返回 `503 EMAIL_NOT_CONFIGURED`，订阅邮件只能落库待发。
3. *可选* —— **GitHub 登录**：在 GitHub 新建 OAuth App，回调填 `https://<你的域名>/_emdash/api/auth/oauth/github/callback`，把 Client ID/Secret 填进 `.env` 的 `EMDASH_OAUTH_GITHUB_CLIENT_ID` / `EMDASH_OAUTH_GITHUB_CLIENT_SECRET`，再跑一次 `npm run deploy:cf`。
4. 若启用 GitHub 登录，务必配置 **`allowed-domains`** 邮箱域名白名单（域名 + `defaultRole`），否则等于对全网开放建号。
5. *可选* —— 灌入 Demo 互动数据：`npm run demo:data:remote`。

## 配置项

| 变量 | 作用 | 是否必需 |
| --- | --- | --- |
| `EMDASH_ENCRYPTION_KEY` | 加密落库的插件密钥 | **必需** |
| `EMDASH_SITE_URL` | 公开 origin（Passkey、CSRF、MCP 发现、sitemap、JSON-LD、图片白名单） | **生产必需** |
| `SITE_THEME` | 构建期默认主题（`news-factory` \| `pulse-news`） | 否（默认 `news-factory`） |
| `EMDASH_OAUTH_GITHUB_CLIENT_ID` | GitHub 登录 client ID | 否 |
| `EMDASH_OAUTH_GITHUB_CLIENT_SECRET` | GitHub 登录 client secret | 否 |
| `EMDASH_TRUSTED_PROXY_HEADERS` | 信任代理头，让限流拿到真实客户端 IP | 建议 |
| `EMDASH_ALLOWED_ORIGINS` | Passkey 额外允许的 origin（逗号分隔） | 否 |
| `DEPLOY_TARGET` | 设为 `cloudflare` 时用 Workers 适配器构建（部署脚本会自动设） | 否 |
| `WRANGLER_HOME` | 作为子进程 `HOME` 的 wrangler 凭据目录 | `deploy:cf` / 远端 D1 需要 |

## 脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 构建插件后启动 Astro dev（SQLite + `./uploads`） |
| `npm run build` | 构建插件 + 默认主题的 Node 产物 |
| `npm run build:news-factory` / `build:pulse-news` | 构建指定主题 |
| `npm run build:cf` | 只构建 Cloudflare（Workers）产物，不部署 |
| `npm run deploy` | 构建 Cloudflare 产物并用当前登录态 `wrangler deploy` |
| `npm run deploy:cf` | 账户无关部署（见上） |
| `npm run typecheck` / `typecheck:all` | 单套 / 两套主题 `astro check` |
| `npm run plugin:build` / `plugin:test` | 构建 / 测试全部插件 |
| `npm run demo:data` | 灌入本地 Demo 互动数据（`:clean` 清理，`:remote` 针对 D1） |
| `npm run perf` | 两套主题的移动端 Lighthouse 复核 |
| `npm run start` | 跑构建后的 Node 产物 |
| `node scripts/configure-search.mjs` | 把搜索索引切成 trigram 分词器（中文搜索用） |

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

规划与参考文档在 [`docs/`](./docs/README.md)（中文）：架构、内容模型、前台主题、后台审核、MCP、插件、路线图、运营手册与实施报告。

## 说明

`postinstall` 会对两个上游插件包打小补丁（`scripts/patch-audit-log.mjs`、`scripts/patch-resend.mjs`），让它们适配当前钉住的 EmDash 版本；上游修复后自动跳过（幂等）。

## 许可

[MIT](./LICENSE) © 2026 daocatt
