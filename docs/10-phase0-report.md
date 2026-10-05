# 10 · Phase 0/1/2 实施报告

> 脚手架、验证、内容模型与报纸前台阶段的记录。随实施推进更新。

## 状态总览

| # | 任务 | 状态 |
| --- | --- | --- |
| 0.1 | 脚手架（astro/worker/live.config/wrangler/seed/AGENTS） | ✅ 完成 |
| 0.2 | 站点标识（Suda Pulse / ai.suda.im / Asia/Shanghai） | ✅ 完成 |
| 0.3 | 依赖安装 + dev 启动 + admin 可达 | ✅ 完成 |
| 0.4 | seed 内容导入（articles/pages/taxonomies/bylines/menu） | ✅ 完成 |
| **Spike 1** | 按月/周范围查询（`where.published_at` gte/lt） | ✅ **通过** |
| **Spike 5** | 沙箱插件注册（`pulse-review`）+ 发布门禁策略 | ✅ **通过** |
| Spike 2 | `bulletin` 订阅 + Resend 发信 | ⏳ 待凭证（Resend API Key） |
| Spike 3 | Resend 传输插件 | ⏳ 待凭证 |
| Spike 4 | Cloudflare Workers AI 评论审核 | ⏳ 待 CF 账号/绑定 |
| Spike 6 | R2 媒体上传/读取 | ⏳ 待 CF 账号（本地用 local storage，媒体管线已通） |
| **Phase 2** | 报纸前台（主题/组件/页面/归档/搜索/Feed） | ✅ **完成**（见下） |

## Phase 1 结果（内容模型与后台）

| 项 | 状态 | 证据 |
| --- | :-: | --- |
| 内容模型（articles/pages/editions/assignments + 图片新闻） | ✅ | seed 全新应用：4 collections / 41 fields / 13 content |
| 生成类型 | ✅ | `emdash-env.d.ts` 含 4 集合 + 图片字段类型 |
| 搜索索引 | ✅ | FTS：5 articles + 4 pages，命中带 `<mark>` 与 score |
| 本地媒体管线 | ✅ | 5 张图片经媒体 API 落盘，2 篇图片新闻（主图 + 图集）已发布 |
| 角色与 RBAC | ✅ | Contributor(20) 建草稿 201 / 发布·定时 403；Admin(50) 发布 200 |
| 发布门禁 | ✅ | 非 approved → 422 `PUBLISH_REJECTED`（与 RBAC 独立） |
| `audit-log` 插件 | ✅ | 建草稿后写入审计条目（action/collection/resourceId/userId/changes） |
| `ai-moderation` / 评论社区插件 | ⏸️ | 见 `07-plugins.md` §5.1（TS 源码打包 / 注册表 DoH 依赖） |
| `bulletin` + Resend | ⏳ | 待 Resend 凭证 |

### Phase 1 新增关键发现

1. **保留字段名**：`status`/`slug`/`id`/`terms`/`bylines`/`*_at`/`version` 等不可用作 field slug（完整清单见 `03-content-model.md` §14）。`assignments.status` 因此改名 `task_status`。
2. **`npx emdash seed` 在受限网络下会丢媒体**：`$media` 下载经 SSRF 校验（Cloudflare DoH），`cloudflare-dns.com` 不可达时静默跳过（字段留空）。兜底脚本：`scripts/seed-local-media.mjs`。
3. **PUT 内容只写 draft revision**：已发布文章改字段后需再 `POST /publish` 才生效到 live。
4. **npm workspaces 管理插件**：根 `npm install` 会清理插件子目录的 `node_modules`；用 `workspaces:["plugins/pulse-review"]` 后依赖提升到根，插件目录**不要**单独 install。
5. **注册表插件安装依赖 DoH**：`registry/publisher-handle.ts` 的 `boundedFetch` 对发布者主机做 SSRF 校验（DoH 解析），本环境 `cloudflare-dns.com` 被封 → `DID_RESOLUTION_FAILED`。官方插件走 npm 不受影响。
6. **RBAC 与策略是两道独立闸门**：角色不足 → 403 `FORBIDDEN`；审核未过 → 422 `PUBLISH_REJECTED`。
7. **媒体值形状**：写接口接受 `{id, src, alt}` 并归一化为含 `provider/filename/mimeType/width/height/blurhash/meta` 的对象；读接口返回的对象**没有** `src`（前端类型里 `src?` 可选）。

## Phase 2 结果（报纸前台）

| 项 | 状态 | 证据 |
| --- | :-: | --- |
| 报纸主题（tokens/theme） | ✅ | 衬线标题、深红强调色、`light-dark()`、`prefers-reduced-motion` |
| 布局与组件 | ✅ | `Base` + `Masthead/NavBar/Footer/Byline/ArticleMeta/StoryCard/LeadStory/SectionBlock` |
| 图片新闻组件 | ✅ | `PhotoGrid`（头版区块）+ `Gallery` + 全局 `Lightbox`（分组/键盘切换） |
| 核心页面 | ✅ | `/`、`/articles/[slug]`、`/sections/[slug]`、`/tags/[slug]`、`/editions/[slug]`、`/pages/[slug]`、`/404` |
| 归档（月/周） | ✅ | `/archive`、`/archive/[year]/[month]`、`/archive/[year]/week/[week]` + `ArchiveNav` + `?page=` 分页 |
| 搜索 | ✅ | `/search` + 报头 `LiveSearch`；trigram 中文检索 + 短查询回退 |
| Feed | ✅ | `/rss.xml`（RSS 2.0，5 items）+ `/feed.json`（JSON Feed 1.1，5 items） |
| 冒烟测试 | ✅ | 26 条路由全部 200/404 符合预期；`npm run build` 通过（仅 chunk 体积警告） |

### Phase 2 新增关键发现

1. **reference 字段不可过滤/排序**（重要）：EmDash 明确拒绝 —— `Cannot filter or sort "articles" by "edition": it is a reference field bound to a relation, and its links are not stored on the entry.`。reference 边存于 `_emdash_content_references`（按 `translation_group` 连接），只支持「正向」读取（`getEmDashEntry(..., { references })` / `getEmDashReferences()`），**没有公开的反向（backlink）查询 API**。因此「期号 → 文章」这类反查必须改用 **taxonomy**（本项目的 `edition`）或自建查询。`assignment` reference 同理。
2. **FTS 默认分词器不适合中文**：EmDash FTS 默认 `porter unicode61`，中文整段成词（`MATCH '审核'` 命中不了「内容审核工作流」）。EmDash 支持 `trigram` 分词器（`SEARCH_TOKENIZERS`），但 **seed/admin/REST 均未暴露 tokenizer 配置**，只能在程序内调 `FTSManager.enableSearch(slug, { tokenize: "trigram" })`。绕行方案（`scripts/configure-search.mjs`）：直接改 `_emdash_collections.search_config.tokenize`，再重跑 `emdash seed` —— `enableSearch` 会**沿用**已有 tokenize 并以 trigram 重建索引。
3. **trigram 的查询下限是 3 个字符**：`MATCH '工作流'` 命中，`MATCH '审核'`（2 字）不命中。因此 `/search` 在 FTS 零结果时对 1–2 字查询做一次内存回退扫描（`src/utils/search.ts`，站点规模小，成本可接受）。
4. **FTS 仅限 SQLite 方言**：`FTSManager` 在非 SQLite 方言下抛错；D1 属 SQLite 方言，理论可用（Phase 5 需在 D1 上复验 FTS5 虚拟表支持）。
5. **布尔字段不能直接用于 `where`**：`WhereValue = string | string[] | WhereRange`，不含 boolean。首页「头条」改用 `where: { priority: "lead" }`（select 字符串）而非 `is_featured: true`。
6. **`getDb()` 不是公开导出**：无法在脚本/路由里直接拿到 Kysely 实例（`FTSManager` 是公开的，但需要 db 句柄）。这限制了程序化的索引维护，故采用「改配置 + 重跑 seed」的绕行。
7. **报头搜索的 `routeMap` 占位符**：`LiveSearch` 支持 `:collection` / `:id` / `:slug` / `:path`；本项目用 `{ articles: "/articles/:slug", pages: "/pages/:slug" }`。

## Spike 1 结果（已通过）


用 `/spike/date-range.json` 验证 `where: { published_at: { gte, lt } }`（半开区间）：

| 查询 | 区间 | 命中 |
| --- | --- | --- |
| 2026-08 | 2026-08-01T00:00Z .. 2026-09-01T00:00Z | review-workflow |
| 2026-09 | 2026-09-01 .. 2026-10-01 | suda-pulse-launch |
| 2026-10 | 2026-10-01 .. 2026-11-01 | image-news-on-r2, agent-newsroom-design |
| 2026-W34 | 2026-08-17 .. 2026-08-24 | review-workflow |
| 2026-W41 | 2026-10-05 .. 2026-10-12 | agent-newsroom-design |
| 2026-W42 | 2026-10-12 .. 2026-10-19 | image-news-on-r2 |

结论：**月/周归档筛选可行**，`src/utils/date-range.ts` 的区间计算正确，可直接用于 Phase 2 的 `/archive` 路由。

## Spike 5 结果（已通过）

**目标**：验证沙箱插件在真实站点中注册、加载，且 `content:beforePublish` 策略钩子能对所有发布通路生效。

**接线方式**（`astro.config.mjs`）：
```js
import pulseReview from "pulse-review";
emdashConfig = {
  // ...
  sandboxed: [pulseReview],
  sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox", // Node 本地
  // Cloudflare 分支：sandboxRunner: sandbox()（来自 @emdash-cms/cloudflare）
};
```
插件以本地依赖链接进项目：`"pulse-review": "file:./plugins/pulse-review"`。

**证据**：

1. 启动日志确认隔离加载：
   ```
   EmDash: Loaded sandboxed plugin pulse-review:0.1.0 with capabilities: [hooks.content-policy:register]
   ```
2. 端到端门禁（REST API，dev-bypass 登录）：
   - 创建 `review_status: pending_review` 草稿 → `POST /publish` 返回 **422 `PUBLISH_REJECTED`**，message 为策略中的中文原因。
   - `PUT` 改为 `review_status: approved` → 再次 `POST /publish` 返回 **200**，`status` 变为 `published`。

结论：**发布门禁由沙箱策略统一把关**，对 REST 通路生效；MCP / 视觉编辑 / 定时发布共用同一 `publish()` 通路，理论上同样受控（Phase 4 再逐条复验）。`pulse-review` 可继续扩展评论审核策略。

## 关键发现（非显而易见，实施时必读）

1. **自动 seed 只建 schema，不含内容**。首次请求的 auto-seed 调用 `applySeed(..., { onConflict: "skip" })`，未传 `includeContent`，因此**内容/术语/署名不会自动导入**。需显式运行：
   ```bash
   npx emdash seed seed/seed.json            # 含内容
   npx emdash seed seed/seed.json --validate # 仅校验
   npx emdash seed seed/seed.json --no-content
   ```
   > 因此 CI/部署脚本需在首次部署后执行一次 `emdash seed`。

2. **seed 内容的分类关联键是 `taxonomies`**（不是 `terms`）。`SeedContentEntry.taxonomies: Record<string, string[]>`。用 `terms` 会被忽略。

3. **select 字段选项键是 `options`**（`field.options`）。

4. **`published_at` 以 ISO 8601 UTC 字符串存储**（如 `2026-10-05T14:57:53.387Z`），字符串比较即时间比较 —— 这正是范围查询可行的基础。

5. **直接用 sqlite3 CLI 改 `ec_articles` 会被 FTS 触发器拦截**（`unsafe use of virtual table "_emdash_fts_articles"`）。需先 `PRAGMA trusted_schema=ON;`。仅用于本地调试，勿在生产如此操作。

6. **Node 版本警告**：部分 EmDash 包要求 `^22.22.2 || ^24.15.0 || >=26.0.0`，本机 `v24.11.1` 触发 `EBADENGINE` 警告（非致命，运行正常）。建议后续升级 Node 到 `24.15+`。

7. **沙箱插件脚手架需要 publisher DID**（非 handle，避免网络解析）。本地站点依赖可先用占位 DID：`did:plc:zp6y7q3n5k2m4x8w9v1t6r0s`。

8. **npm 冷启动 + 网络不稳**：首次安装可能 `ECONNRESET`；用 `npm install --prefer-offline --no-audit --no-fund` 重试即可。

9. **`@emdash-cms/plugin-test@0.1.0` 内置旧版 plugin-cli（0.11.0）**，不识别 `hooks.content-policy:register` 等新能力，导致 `npm run test` 报 `MANIFEST_INVALID`（而 `npm run validate` 用的是顶层 0.13.2，能通过）。**须将 plugin-test 升级到 `^0.2.7`**，并把插件 devDependency 的 `emdash` 对齐到 `^1.1.0`。

10. **沙箱插件能力名**（`emdash@1.1.0` 运行时支持，经 `grep` 确认）：`hooks.content-policy:register` 用于发布策略钩子（`content:beforePublish` / `beforeSchedule` / `beforeUnpublish`），**不需要** `content:read/write/publish`。

11. **沙箱插件在 Node 本地需 `@emdash-cms/sandbox-workerd`**（依赖 `workerd` + `miniflare`），配置为 `sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox"`。Cloudflare 端用 `sandbox()`（来自 `@emdash-cms/cloudflare`，返回 runner 模块路径；Worker Loader 不可用时返回 `undefined`，此时沙箱插件在构建期被禁用）。

12. **沙箱插件 descriptor 的 `entrypoint` 必须能通过 `require.resolve` 解析到「已构建的 JS」**。`generateSandboxedPluginsModule` 用 `createRequire(project/package.json).resolve(entrypoint)` 定位文件，并直接读取源码文本内嵌进沙箱。因此：
    - 插件 package.json 的 `exports` 必须提供 **`default` 条件**（CJS 解析只用 `require`/`default`），仅有 `import` 会导致 `ERR_PACKAGE_PATH_NOT_EXPORTED`；
    - 必须**先 `npm run build`** 生成 `dist/*.mjs`，指向 TS 源码会报 "resolves to unbuilt source"；
    - 沙箱 entry 的 bundle 需**无外部 import**（当前 `dist/plugin.mjs` 已内联全部逻辑）。
    - 本地开发用 `file:` 依赖把插件链接进 `node_modules`，`entrypoint: "pulse-review/sandbox"` 才能解析。

13. **REST API 测试要点**：写请求需 `X-EmDash-Request: 1` 头（CSRF），否则 403 `CSRF_REJECTED`；内容更新用 **`PUT`**（非 PATCH）；登录可用 `/_emdash/api/setup/dev-bypass`。另：编辑 `astro.config.mjs` 会触发 dev server 重启，若在重启窗口内发请求会报 `Vite module runner has been closed`（500），**等重启完成再请求**即可。

## 环境

- Node v24.11.1（建议 24.15+），npm 11.7.0
- Astro 7.3.5 · EmDash 1.1.0
- 本地：SQLite `data.db` + `./uploads`；后台 `/_emdash/admin`（首次重定向 `/setup`）

## 待凭证/账号事项

- **Resend**：需要 API Key 才能验证发信（Spike 2/3）。
- **Cloudflare**：需要账号 + `HOME=~/.wrangler-a` 登录，创建 D1/R2 并启用 Workers AI（Spike 4/6）。
- 邮件订阅插件 `bulletin` 的安装与配置同样依赖上述。
