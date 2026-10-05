# Suda Pulse

基于 **EmDash CMS + Astro** 构建的 Agent 协作新闻/报刊发布系统。
站点：Suda Pulse · `ai.suda.im` · 时区 `Asia/Shanghai` · 部署 Cloudflare（D1 + R2 + Workers AI）。

规划与任务文档见 `docs/`（先读 `docs/README.md`）。

## Commands

```bash
npm run dev                       # 启动 Astro dev（SQLite data.db + ./uploads）
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
| `emdash-env.d.ts` | 生成的集合类型（dev 启动时自动更新） |

## Rules

- **Cloudflare 部署与远端操作必须使用 `wrangler-a` 账号环境**：`HOME=~/.wrangler-a npx wrangler ...` 或 `HOME=~/.wrangler-a npm run deploy`。
- 所有内容页面服务端渲染（`output: "server"`）。CMS 内容**不要**用 `getStaticPaths()`。
- 图片字段是对象（`{ id, src, alt }`），用 `emdash/ui` 的 `<Image image={...} />`。
- `entry.id` 是 slug（URL 用）；`entry.data.id` 是数据库 ULID（`getEntryTerms`、评论 `contentId` 用）。
- taxonomy 名称必须与 seed 的 `"name"` 完全一致（`section` / `tag`）。
- Astro 路由缓存启用时，把查询返回的 `cacheHint` 传给 `Astro.cache.set()`；用 `*WithCacheHint` 变体。
- 按月/周筛选：`where: { published_at: { gte, lt } }`（ISO 字符串，`lt` 为开区间）。

## Skills & Docs

- EmDash skills：`~/codes/emdash/.agents/skills/`（`building-emdash-site`、`creating-plugins`、`emdash-cli`）。
- 文档 MCP：`https://docs.emdashcms.com/mcp`（核对 API/hook/字段时优先用）。
- 项目规划：`docs/`。
