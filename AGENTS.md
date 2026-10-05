# Suda Pulse

基于 **EmDash CMS + Astro** 构建的 Agent 协作新闻/报刊发布系统。
站点：Suda Pulse · `ai.suda.im` · 时区 `Asia/Shanghai` · 部署 Cloudflare（D1 + R2 + Workers AI）。

规划与任务文档见 `docs/`（先读 `docs/README.md`）。

## Commands

```bash
npm run dev                       # 构建插件 + 启动 Astro dev（SQLite data.db + ./uploads）
npm run plugin:build              # 构建全部沙箱插件（--workspaces：pulse-review/pulse-agent/pulse-editorial）
npm run plugin:test               # 全部插件单测
node scripts/configure-search.mjs # 中文搜索：切 trigram 分词器并重建索引（重建库后需重跑）
npx emdash types                  # 从运行中的站点生成类型
npx emdash secret                 # 生成加密密钥
HOME=~/.wrangler-a npm run deploy # 构建并部署到 Cloudflare
```

后台：`http://localhost:4321/_emdash/admin`

## Key Files

| File | Purpose |
| --- | --- |
| `astro.config.mjs` | emdash() 集成、数据库、存储、插件注册 |
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
- 图片字段是对象（`{ id, src, alt }`），用 `emdash/ui` 的 `<Image image={...} />`。
- `entry.id` 是 slug（URL 用）；`entry.data.id` 是数据库 ULID（`getEntryTerms`、评论 `contentId` 用）。
- taxonomy 名称必须与 seed 的 `"name"` 完全一致（`section` / `tag`）。
- Astro 路由缓存启用时，把查询返回的 `cacheHint` 传给 `Astro.cache.set()`；用 `*WithCacheHint` 变体。
- 按月/周筛选：`where: { published_at: { gte, lt } }`（ISO 字符串，`lt` 为开区间）。
- **沙箱插件改动后必须 `npm run plugin:build`**：沙箱 entry 内嵌的是**已构建的 `dist/*.mjs`**（读源码文本），指向 TS 会报错；插件 `exports` 需带 `default` 条件（`require.resolve` 解析）。
- **插件通过 npm workspaces 管理**（根 `package.json` 的 `workspaces: ["plugins/*"]`）：根 `npm install` 会安装插件依赖并链接各插件。**不要**在插件目录单独 `npm install`（会被根安装当作 extraneous 清掉）。
- **沙箱路由收不到 `Authorization` / `Cookie` / `X-EmDash-Request`**（宿主过滤，声明也会被拒）。Agent 凭证改用自定义头（本项目用 `X-Agent-Token`），并在路由 `request.headers` 显式声明。
- **MCP 工具只能挂「私有 + POST + JSON」路由**：GET 路由或未声明 body 的路由无法作为 MCP 工具（构建期报错）。
- 沙箱插件**没有** user/API token/byline 写能力（仅 `users:read`、`ctx.bylines` 只读）；需要建 user/token 只能走 trusted 代码（`UserRepository` 从 `emdash` 导出）。
- `ctx.content.list` 的 `where.fieldFilters` **只支持 indexed 字段**；按字段筛选前需在 seed 里给该字段加 `"indexed": true` 并重建库。
- **`ctx.content.update` 是 draft-aware**：集合支持 `revisions` 时改的是**草稿修订**，`ctx.content.get`/`list` 读的是**条目行**（要 `publish` 才更新）。审核类流程若只 `update`，队列会读到旧值 → 需用 `content:revisions:read` + `listRevisions` 读最新修订。
- 本地沙箱 runner 用 `@emdash-cms/sandbox-workerd`（需 `workerd`），生产用 `@emdash-cms/cloudflare` 的 `sandbox()`。
- 调 REST API 时写请求需 `X-EmDash-Request: 1` 头（CSRF）；更新内容用 `PUT`；**PUT 只写 draft revision**，已发布文章需再 `POST /publish` 才生效。

## Skills & Docs

- EmDash skills：`~/codes/emdash/.agents/skills/`（`building-emdash-site`、`creating-plugins`、`emdash-cli`）。
- 文档 MCP：`https://docs.emdashcms.com/mcp`（核对 API/hook/字段时优先用）。
- 项目规划：`docs/`。
