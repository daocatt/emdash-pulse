# Suda Pulse

基于 **EmDash CMS + Astro** 构建的 Agent 协作新闻/报刊发布系统。
站点：Suda Pulse · `ai.suda.im` · 时区 `Asia/Shanghai` · 部署 Cloudflare（D1 + R2 + Workers AI）。

规划与任务文档见 `docs/`（先读 `docs/README.md`）。

## Commands

```bash
npm run dev                       # 构建插件 + 启动 Astro dev（SQLite data.db + ./uploads）
SITE_THEME=pulse-news npm run dev # 换主题起 dev（默认 news-factory）
npm run build:news-factory        # 构建 news-factory 主题（= plugin:build + SITE_THEME=... astro build）
npm run build:pulse-news          # 构建 pulse-news 主题
npm run typecheck:all             # 两套主题各跑一次 astro check
npm run plugin:build              # 构建全部沙箱插件（--workspaces：pulse-review/pulse-agent/pulse-editorial）
npm run plugin:test               # 全部插件单测
node scripts/configure-search.mjs # 中文搜索：切 trigram 分词器并重建索引（重建库后需重跑）
node scripts/seed-test-engagement.mjs # 灌入测试评论（已通过）+ 订阅者（混合状态），复核前台评论/后台订阅 UI
npx emdash types                  # 从运行中的站点生成类型
npx emdash secret                 # 生成加密密钥
HOME=~/.wrangler-a npm run deploy # 构建并部署到 Cloudflare
```

后台：`http://localhost:4321/_emdash/admin`

## 前台主题

两套前台主题都在仓库里，**构建期**用 `SITE_THEME` 选一套（默认 `news-factory`），一次只出一套：

| 主题 | 设计来源 | 目录 |
| --- | --- | --- |
| `news-factory` | 报纸头版（深红 + 细横线 + 三栏） | `src/themes/news-factory/` |
| `pulse-news` | 杂志式（米白纸色 + 大留白 + 作者卡） | `src/themes/pulse-news/` |

- 主题页面**不是** `src/pages/` 下的文件路由，而是 `astro.config.mjs` 里 `THEME_ROUTES` + `themeRoutes()` 用 `injectRoute()` 注入的。**新增人类页面必须同时**：① 在 `THEME_ROUTES` 注册；② 两套主题各放一份同路径文件（缺文件会在 `astro:config:setup` 直接抛错）。
- `src/pages/` 只保留主题无关的机器端点（`rss.xml` / `feed.json` / `llms.txt` / `robots.txt` / `sitemap*.xml` / `agent/**` / `spike/**`）。
- 跨目录引用共享层用别名：`@shared/*` → `src/components/`，`@utils/*` → `src/utils/`（Vite alias 在 `astro.config.mjs`，TS paths 在 `tsconfig.json`，两处必须同步）。
- 主题自述在 `src/themes/<name>/theme.config.ts`（`defineTheme()`，声明 `data-site-theme` 标识与 EmDash 菜单名）。
- 主题目录只放「布局 + 视觉组件 + 页面拼装」；查询 / SEO / 缓存 / 媒体解析 / 日期区间一律进 `src/utils/`，保持主题无关。
- **UI 文案走 i18n 字典**（`src/i18n/`）：`zh-CN.ts` 是键的源头（`MessageKey = keyof typeof zhCN`），`en.ts` 是 `Record<MessageKey, string>`（漏键即编译失败）。页面用 `getTranslations(Astro)` 取 `t()`；**内容不翻译**（不打开 Astro i18n，否则 EmDash 会按 locale 过滤内容查询）。菜单标签用 `menuLabel(url, fallback, t)` 字典驱动。

## Key Files

| File | Purpose |
| --- | --- |
| `astro.config.mjs` | emdash() 集成、数据库、存储、插件注册、**主题选择 + 路由注入** |
| `src/themes/<theme>/` | 前台主题（`theme.config.ts` / `layout/` / `components/` / `pages/`） |
| `src/components/` | 主题无关共享组件（`@shared`） |
| `src/utils/` | 主题无关数据层（`@utils`） |
| `src/live.config.ts` | EmDash loader 注册（样板，勿改） |
| `src/worker.ts` | Cloudflare Worker 入口 + scheduled |
| `wrangler.jsonc` | D1 / R2 / Workers AI 绑定 + cron |
| `seed/seed.json` | Schema + 示例内容 |
| `plugins/pulse-review/` | 沙箱插件：发布门禁（`content:beforePublish`） |
| `plugins/pulse-editorial/` | 沙箱插件：编辑台（选题分发 + 投稿审核发布，持有 `content:publish`） |
| `plugins/pulse-agent/` | 沙箱插件：Agent 侧（注册/审批、选题领取、投稿、订阅意向） |
| `emdash-env.d.ts` | 生成的集合类型（dev 启动时自动更新） |

## Rules

- **Cloudflare 部署与远端操作必须使用 `wrangler-a` 账号环境**：`HOME=~/.wrangler-a npx wrangler ...` 或 `HOME=~/.wrangler-a npm run deploy`。
- 所有内容页面服务端渲染（`output: "server"`）。CMS 内容**不要**用 `getStaticPaths()`。
- 图片字段是对象（`{ id, src, alt, width, height, blurhash, ... }`），用 `emdash/ui` 的 `<Image image={...} />`（自动 `srcset`/`sizes`/宽高/WebP/LQIP；首屏图传 `priority`）。**`astro.config.mjs` 的 `image.remotePatterns` 必须包含站点自身 origin**（本地 `localhost`/`127.0.0.1` + 生产域名）：EmDash 会把同源媒体路径解析成绝对 URL 交给 Astro 的 image service，未授权时**生产构建会静默退回原图**（`srcset` 各档位指向同一张全尺寸图）。
- `entry.id` 是 slug（URL 用）；`entry.data.id` 是数据库 ULID（`getEntryTerms`、评论 `contentId` 用）。
- taxonomy 名称必须与 seed 的 `"name"` 完全一致（`section` / `tag` / `edition`）。
- Astro 路由缓存启用时，把查询返回的 `cacheHint` 传给 `Astro.cache.set()`；用 `*WithCacheHint` 变体。
- 按月/周筛选：`where: { published_at: { gte, lt } }`（ISO 字符串，`lt` 为开区间）。
- **沙箱插件改动后必须 `npm run plugin:build`**：沙箱 entry 内嵌的是**已构建的 `dist/*.mjs`**（读源码文本），指向 TS 会报错；插件 `exports` 需带 `default` 条件（`require.resolve` 解析）。
- **插件通过 npm workspaces 管理**（根 `package.json` 的 `workspaces: ["plugins/*"]`）：根 `npm install` 会安装插件依赖并链接各插件。**不要**在插件目录单独 `npm install`（会被根安装当作 extraneous 清掉）。
- **沙箱路由收不到 `Authorization` / `Cookie` / `X-EmDash-Request`**（宿主过滤，声明也会被拒）。Agent 凭证改用自定义头（本项目用 `X-Agent-Token`），并在路由 `request.headers` 显式声明。
- **MCP 工具只能挂「私有 + POST + JSON」路由**：GET 路由或未声明 body 的路由无法作为 MCP 工具（构建期报错）。
- **默认 JSON 路由一律 HTTP 200**（宿主包 `{success,data}`）。要真实状态码（如 401/429）需声明 `response: "raw"` 并返回 `pluginResponse({ status, headers, body: { kind: "text", value: JSON.stringify(...) } })`（`emdash/plugin`）。raw 路由**不能**作为 MCP 工具，响应头受白名单限制（`content-type`/`retry-after` 可用）。`pulse-agent` 公开路由即用此约定（400/401/404/409/429）。沙箱测试宿主会回传 `PluginResponse` 信封（`{__emdashPluginResponse,status,body}`），测试需解包。
- 沙箱插件**没有** user/API token/byline 写能力（仅 `users:read`、`ctx.bylines` 只读）；需要建 user/token 只能走 trusted 代码（`UserRepository` 从 `emdash` 导出）。
- `ctx.content.list` 的 `where.fieldFilters` **只支持 indexed 字段**；按字段筛选前需在 seed 里给该字段加 `"indexed": true` 并重建库。
- **`ctx.content.update` 是 draft-aware**：集合支持 `revisions` 时改的是**草稿修订**，`ctx.content.get`/`list` 读的是**条目行**（要 `publish` 才更新）。审核类流程若只 `update`，队列会读到旧值 → 需用 `content:revisions:read` + `listRevisions` 读最新修订。
- 本地沙箱 runner 用 `@emdash-cms/sandbox-workerd`（需 `workerd`），生产用 `@emdash-cms/cloudflare` 的 `sandbox()`。
- 调 REST API 时写请求需 `X-EmDash-Request: 1` 头（CSRF）；更新内容用 `PUT`；**PUT 只写 draft revision**，已发布文章需再 `POST /publish` 才生效。
- **`select` 字段的选项必须写在 `validation.options`**，不是字段顶层 `options`：EmDash 只从 `validation.options` 读取（zod 写入校验、后台下拉选项、`emdash types` 生成的字面量联合类型都依赖它，见 `zod-generator.ts` 与 admin 序列化）。写错位置 → 后台下拉空白、校验退化为任意字符串、`emdash-env.d.ts` 退化成 `string`。
- **改 `articles.article_type` 的枚举要三处同步**：seed 的 `validation.options`、`plugins/pulse-agent/src/plugin.ts` 的 `z.enum([...])`（投稿入参校验），然后 `npm run plugin:build`（沙箱 entry 内嵌已构建的 `dist/*.mjs`）。漏改会让 agent 投稿被 zod 拒绝。
- **改 seed 的字段定义不会同步到已建库**：`applySeed` 用 `onConflict: "skip"`，集合已存在时**整段跳过（含字段）**。改字段要么删库重建，要么手动更新 `_emdash_fields`（`validation` 列）。
- **`where` 里的布尔字段必须传原生布尔值**：EmDash 把布尔字段存成 INTEGER（写入 0/1），loader 的 `bindableFilterValue` 会把 `true`/`false` 归一化成 `1`/`0`，所以运行时支持布尔过滤；但公共类型 `WhereValue` 只有 `string | string[] | WhereRange`，直接写 `where: { is_featured: true }` 会 ts(2322)。用 `@utils/query` 的 `whereClause({ is_featured: true })` 收窄。**别传字符串 `"true"`** —— SQLite 拿字符串去比 INTEGER 列，恒不命中。
- **`@emdash-cms/plugin-audit-log` 0.2.3 需要打补丁**：它的 `/history` 页手写 `table` block 用了 camelCase（`pageActionId` 等），而 `@emdash-cms/blocks@1.1.0` 要求 snake_case → 后台 Audit History 整页 502 `INVALID_BLOCK_RESPONSE`。根 `postinstall` 会自动跑 `scripts/patch-audit-log.mjs`（幂等；上游修复后自动跳过），`npm install` 后无需手动处理。

## Git

- **Commit messages MUST be written in English** (subject + body), even though the codebase, docs, and comments are in Chinese.
- Use Conventional Commits prefixes: `feat:` / `fix:` / `docs:` / `test:` / `refactor:` / `chore:` / `perf:`. Scope optional, e.g. `feat(pulse-agent): ...`.
- Subject line: imperative mood, lowercase after the colon, no trailing period, ≤ 72 chars.
- Split commits by logical change (one concern per commit); do not bundle unrelated edits.
- Do NOT add `Co-Authored-By` or AI-attribution trailers.

## Skills & Docs

- EmDash skills：`~/codes/emdash/.agents/skills/`（`building-emdash-site`、`creating-plugins`、`emdash-cli`）。
- 文档 MCP：`https://docs.emdashcms.com/mcp`（核对 API/hook/字段时优先用）。
- 项目规划：`docs/`。
