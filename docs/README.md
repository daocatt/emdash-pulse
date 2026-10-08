# Suda Pulse — 报刊发布系统规划文档

> 基于 [EmDash CMS](https://github.com/emdash-cms/emdash) + [Astro](https://astro.build/) 构建的 **AI 时代新闻 / 报刊发布系统**。
> **双前台主题**（`news-factory` 报纸头版 / `pulse-news` 杂志式，默认 `SITE_THEME`、后台可运行期切换），后台内容审核 + 多用户，**Author agent 生产 / Editor agent 审核发布**，双阅读面（人类 UI + Agent API），支持图片新闻、播客/视频、RSS、邮件订阅。

**站点**：Suda Pulse · `pulse.suda.im` · `Asia/Shanghai` · 部署于 Cloudflare（D1 + R2 + Workers AI）。

本目录是**实施前的规划与任务文档**。请先审阅并确认，确认后再进入编码阶段。

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [01-overview.md](./01-overview.md) | 愿景、范围/非目标、角色（含 Agent）、关键决策（ADR）、决策收敛结果 |
| [02-architecture.md](./02-architecture.md) | 技术栈、架构、R2 图片管线、部署、核心约束 |
| [03-content-model.md](./03-content-model.md) | collections/fields/taxonomies/menus/widgets/seed（含图片新闻、期号、选题） |
| [04-frontend-themes.md](./04-frontend-themes.md) | **前台双主题**（news-factory / pulse-news）：`SITE_THEME` 切换、路由注入、令牌分层、i18n、页面模式、组件、响应式 |
| [05-admin-review.md](./05-admin-review.md) | 后台、多用户角色、内容审核工作流、评论审核 |
| [06-mcp-agents.md](./06-mcp-agents.md) | MCP 机制：通道、鉴权、工具、路由、安全 |
| [07-plugins.md](./07-plugins.md) | 官方/社区插件采用 + 自研插件清单 |
| [08-roadmap.md](./08-roadmap.md) | Phase 0–5 路线图、任务、验收、风险 |
| [09-agent-newsroom.md](./09-agent-newsroom.md) | **Agent 新闻室**：选题分发、Author/Editor agent、Agent Read API |
| [10-phase0-report.md](./10-phase0-report.md) | **实施报告**：Spike 结论、Phase 1/2/3/4 进展、关键发现（含踩坑） |
| [11-phase3-comments-subscriptions.md](./11-phase3-comments-subscriptions.md) | **Phase 3 报告**：评论审核（规则 + AI）与读者订阅（`pulse-subscriptions`） |
| [12-operations.md](./12-operations.md) | **运营手册**：角色职责、巡检清单、编辑流程 SOP、Agent 投稿规范、评论/订阅规范、异常处理 |
| [13-editor-onboarding.md](./13-editor-onboarding.md) | **第三方 Editor 接入**（已实现）：用户成为 editor + GitHub 登录 + EmDash OAuth；申请页 `/editor/apply` + `pulse-editor-applications` 后台审批队列 |
| [14-database.md](./14-database.md) | **数据库选型与查询负载复核**：为何继续用 D1（FTS 仅 SQLite 方言）、D1 2026-09 硬限额、索引实测（单字段索引不被选用）、缓存才是杠杆 |

---

## 当前进度

- **Phase 0**：脚手架 ✅、Spike 1（月/周查询）✅、Spike 5（插件注册 + 发布门禁）✅、Spike 2（订阅）✅、Spike 3（Resend 插件已接入，真实发信待 API key）；Spike 4（CF Workers AI）/ Spike 6（R2）待 CF 账号。
- **Phase 1**：内容模型 ✅、类型 ✅、搜索 ✅、本地媒体管线 ✅、角色/RBAC ✅、发布门禁 ✅、`audit-log` ✅；评论/订阅已由 Phase 3 的自研插件承担，Resend 待凭证。
- **Phase 2**：报纸前台 ✅ —— 主题/布局/组件、头版、文章页、版块/标签/期号/静态页、月/周归档、搜索、RSS + JSON Feed；`npm run build` 通过。
- **Phase 2b（双主题重构）**：前台重做为**两套可切换主题**（`news-factory` 报纸头版 / `pulse-news` 杂志式），构建期 `SITE_THEME` 二选一、`injectRoute` 注入 14 条人类路由；抽出**共享层**（`@shared` 组件 + `@utils` 数据层 + 令牌契约 `tokens.base.css`）与 **UI 文案 i18n**（`zh-CN` 默认 + `en`，cookie 运行期切换，内容不翻译）；内容模型扩展**播客 / 视频 / 热度**（`article_type` 加 `podcast`，新增 `audio_*` / `video_*` / `trending_rank`）；两套主题各 14 页全部实现，`typecheck:all` 两套 0 error、`build:*` 均通过。详见 [04-frontend-themes.md](./04-frontend-themes.md)。
- **Phase 4（部分）**：**Agent Read API** ✅ —— 9 个公开只读端点（`/agent/news`、`/agent/news/{slug}`、`/agent/sections`、`/agent/editions`、`/agent/feed.json`、`/agent/schema`、`/llms.txt` 等）+ 按 IP 限流。
- **Phase 4b（写侧）**：`pulse-editorial`（编辑台：选题 + 审核发布，独占 `content:publish`）与 `pulse-agent`（Agent 侧：自助注册/审批 + token、选题领取、投稿、订阅意向）✅；MD→PT 转换 ✅。
- **Phase 4c（MCP 接入）**：三个插件的 MCP 工具已启用；`POST /_emdash/api/mcp`（Bearer token）`tools/list` 返回 **85 工具**（72 内置 + 13 插件），工具调用与 scope 强制均实测通过 ✅；客户端接入文档 `/pages/agents` ✅。
- **Phase 4d（端到端验收）**：`scripts/agent-e2e.mjs` 真实 HTTP 全链路 **26/26 通过**（注册→审批→选题→领取→投稿→审核发布→发布门禁→越权隔离）；E2E 暴露并修复两个真实 bug（沙箱写 reference 字段、`assignments` 草稿化导致重复领取）✅。**M4 达成**。
- **Phase 4e（接入文档）**：`/pages/agents` 接入文档（MCP 配置 / Read API / 投稿流程 / 审核门禁 / 最小权限）✅；`/llms.txt` 增加写侧 MCP 段。
- **Phase 4f（限流复核 + scoped token）**：限流改为**每 `(route,client)` 一键、窗口锚定首次请求**（修掉 KV 键无界增长与整点双倍放行），实测 429 + `retry-after` ✅；`pulse-agent` 补齐 **scope 逐路由强制**（缺则 403，修掉「记录但不校验」的越权缺口）✅；`scripts/create-agent-tokens.mjs` 幂等生成 editor/reader 的 MCP scoped token 并自动验证 ✅。
- **Phase 3**：评论审核（`pulse-review` 独占 `comment:moderate`：规则引擎 + Workers AI，失败降级不自动通过）✅；评论主题（`--ec-*`）✅；**自研 `pulse-subscriptions`**（双确认 / 退订 / 订阅者管理 + 后台页 + MCP）✅；订阅前台（`SubscribeForm` + `/subscribe`、`/subscribe/confirm`、`/subscribe/unsubscribe`）✅。Resend 真实投递待凭证（未配置时落库 `pendingEmail`）。
- **Phase 5a（SEO 复核）**：新增**可信插件 `pulse-seo`**（`page:metadata`）统一 JSON-LD，文章页由 2 → 1 个 `ld+json`（`NewsArticle`）✅；`/sitemap.xml` 覆盖并补 `sitemap-sections.xml`/`sitemap-tags.xml` ✅；`/robots.txt` 覆盖并 `Disallow: /spike/` ✅；文章页 `og:image` 回退题图 ✅。插件测试合计 **116**。
- **Phase 5b（性能）**：全站图片改用 `emdash/ui` 的 `<Image>`（`srcset` 640–3200w、按栅格给出 `sizes`、`width`/`height`、WebP、LQIP），首屏图 `priority` ✅；新增 `image.remotePatterns` 修复**生产环境** srcset 退化为原图 ✅；字体维持系统栈（公开页 0 字体请求）✅；顺带修 `seed-local-media.mjs`（PUT 覆盖导致图片进不了 live）与 dev watcher（`uploads/` 触发重启）。
- **Phase 5c（运营文档）**：新增 [12-operations.md](./12-operations.md) —— 角色职责、每日/周/月巡检清单、编辑流程 SOP（选题→跟稿→审稿→发布→更正）、Agent 投稿规范（字段约束/正文/图片/来源/禁则/审稿清单）、评论与订阅规范、异常处理、权限红线与工具速查。
- **Phase 5d（后台缺陷修复）**：① `select` 选项改到 `validation.options` —— 原先写在字段顶层，导致后台「稿件类型」下拉空白、写入校验退化为任意字符串、生成类型退化为 `string`（影响 6 个字段）✅；② `@emdash-cms/plugin-audit-log@0.2.3` 的 `/history` 页 Block Kit 字段名打补丁（camelCase → snake_case），修掉整页 502 `INVALID_BLOCK_RESPONSE`，由根 `postinstall` 固化 ✅。
- **Phase 5e（上线准备）**：① **账户无关部署** `npm run deploy:cf`（`scripts/deploy-cf.mjs` + `scripts/lib/cf.mjs`）—— 账号目录 / account id 全落在 gitignored 的 `.env.deploy` 与 `wrangler.prod.jsonc`（模板 `.example` 提交），流程为 whoami 自检 → 幂等建 R2 桶 → 缺 `EMDASH_ENCRYPTION_KEY` 时写入 secret → `plugin:build` → CF 构建 → `wrangler deploy` ✅；② **Demo 互动数据** `scripts/demo-data.mjs`（`demo:data` / `:clean` / `:remote`，取代 `seed-test-engagement.mjs`）—— 评论 + 订阅者/分组/事件，本地 `node:sqlite` 与远端 D1 共用同一份 SQL ✅；③ **全部插件改为 in-process**（`plugins: []`，弃用 `sandboxed`）—— Workers 免费计划没有 Worker Loader 绑定，沙箱插件会静默全部不加载 ✅；④ **接入 `emdash-plugin-resend@0.2.0`**（独占 `email:deliver`，magic link / 订阅确认信依赖它）✅。
- **Phase 6（第三方 Editor 接入）** ✅：让站外的人/组织成为 editor、其 agent 自动获得编辑能力。方案 = **EmDash Editor 用户 + GitHub 登录（`authProviders: [github()]`）+ 原生 OAuth**（不自研 token）；自建部分 = 申请页 `/editor/apply`（两套主题）+ 插件 `pulse-editor-applications`（申请/审批 + Block Kit 后台队列 + 3 个 MCP 工具）；`deploy:cf` 支持写 GitHub OAuth secret；批准后管理员在 Users 页改角色为 Editor(40)。`plugin:test` / `typecheck:all` / 生产构建均通过。**运行时配置（GitHub OAuth app、邮箱域名白名单）与审批 SOP 见 [13-editor-onboarding.md](./13-editor-onboarding.md) §5 与 [12-operations.md](./12-operations.md) §3.6**。
- **Phase 5f（数据库复核 + 缓存）** ✅：确认**继续用 D1**（换 Postgres 会丢 FTS 中文搜索 + 放弃整套 CF 栈）；`articles` 的 `article_type` / `is_featured` / `priority` 补 `indexed`；D1 加 `coalesce: true`。复核发现：**EmDash 的 `indexed` 生成的单字段索引，对「等值过滤 + 按 `published_at` 排序」查询不被 SQLite 优化器选用**（不是性能杠杆）；真正的读负载杠杆是缓存 —— 已**启用 Workers Cache**（`cacheCloudflare()` + `routeRules`，仅 CF 部署注入），并让 `src/middleware.ts` 给会话 / 表单 / 错误页统一设 `private, no-store`。详见 [14-database.md](./14-database.md)。
- 详见 [10-phase0-report.md](./10-phase0-report.md) 与 [11-phase3-comments-subscriptions.md](./11-phase3-comments-subscriptions.md)（含每阶段关键发现与踩坑）。

---

## 一句话架构

```
人类读者 ──双主题UI──▶ Astro SSR ──┐
人类读者 ──订阅──▶ pulse-subscriptions ──▶ 邮件传输（Resend，未配置则落库待发）
Author agent ──MCP/HTTP──▶ pulse-agent ──▶ EmDash Core ──▶ D1(内容) + R2(媒体) + Workers AI
Editor agent ──MCP/HTTP──▶ pulse-editorial ─┤
评论访客 ──▶ EmDash 评论 ──▶ pulse-review（规则 + AI 审核）
Reader agent ──MCP/HTTP JSON──▶ Agent Read API ─┘
```

---

## 需求 → 实现路径速查

| 需求 | 实现方式 | 复用/自研 |
| --- | --- | --- |
| 后台管理 | EmDash 内置 Admin | 复用 |
| 多用户 | EmDash 5 角色 RBAC + Passkey | 复用 + 配置 |
| 内容审核 | 草稿 + `review_status` + `pulse-review` 发布策略 | 自研 |
| **Author agent 投稿 / Editor agent 审核** | `pulse-editorial` + `pulse-agent` + 独立 agent 身份/token | 自研 |
| **第三方 Editor 接入** | GitHub 登录（原生）+ 申请页 + `pulse-editor-applications` + 原生 OAuth | 复用 + 自研 |
| **Agent 阅读 API** | MCP + HTTP JSON（`/agent/*`、JSON Feed、`llms.txt`） | 自研 |
| **图片新闻** | `article_type`/`gallery` 字段 + 图集布局 + **R2** | 自研 + R2 |
| 期号 | `editions` collection + `/editions/[slug]` | 自研 |
| 选题分发 | `assignments` collection | 自研 |
| RSS | `/rss.xml` + `/feed.json` + 分版块 `/sections/[slug]/rss.xml` | 自研 |
| 邮件订阅 | **自研 `pulse-subscriptions`**（双确认 + 退订 + 订阅者管理） | 自研 |
| 邮件传输 | **Resend**（`emdash-plugin-resend`，独占 `email:deliver`；未配置时落库待发） | 插件 |
| 新闻分类 | taxonomy `section`（hierarchical） | 复用 |
| 标签 | taxonomy `tag`（flat） | 复用 |
| 评论 | 内置评论 + `pulse-review` 规则/AI 审核 + 报纸主题覆盖 | 复用 + 自研 |
| 前台 UI | 自研双主题（`news-factory` / `pulse-news`，默认 `SITE_THEME` + 后台可切换） | 自研 |
| 按月/周筛选 | `where: { published_at: { gte, lt } }` + 归档路由 | 自研 |
| 搜索 | EmDash 内置 FTS + LiveSearch | 复用 |
| 部署 | Cloudflare Workers + D1 + R2 + Workers AI | 复用 |

---

## 已确认决策（D1–D22）

- **D4（修订）** 邮件订阅**自研 `pulse-subscriptions`**（原定社区 `bulletin`）；**D5** 传输用 Resend
- **D11** Author（人类 + agent）稿件**强制审核**
- **D12/D20** 引入期号 `editions`，**周报优先**
- **D13/D19** 提供 **Agent Read API**（MCP + HTTP JSON），**公开只读 + 限流**
- **D14/D21** 评论 **CF Workers AI 审核为主，人工后期干预**
- **D15/D18** 每个 author agent 独立身份 + scoped token，**自助注册 + 审批**
- **D16** 选题分发用 **`assignments` collection**
- **D17** Editor agent **AI 审核建议 + 人工/一键确认**（可配置全自动）
- **D22** 第三方 editor 接入 = **EmDash Editor 用户 + OAuth**（**用户**成为 editor，其 agent 自动继承能力，**不给 agent 单独类型**）；**GitHub 登录** + 邮箱域名白名单；新用户默认 **Subscriber**；登录后**申请页 + 后台审批队列**，批准后管理员在 Users 页改角色。
- 站点：Suda Pulse / pulse.suda.im / Asia/Shanghai；部署 Cloudflare + D1 + R2 + Workers AI

> 全部关键决策已确认，无剩余阻塞项。次要选择（分析/SEO 插件、限流阈值、月报）在对应 Phase 内决策。

---

## 参考

- EmDash 官方示例站：脚手架 / seed / RSS / 部署参考。
- 文档 MCP：`https://docs.emdashcms.com/mcp`（`search_docs`）。
- 插件注册表：`https://plugins.emdashcms.com`。

## 约定

- **Cloudflare 部署/远端操作统一走 `npm run deploy:cf` / `npm run demo:data:remote`**：账号目录由本地 `.env.deploy`（gitignored，模板 `.env.deploy.example`）的 `WRANGLER_HOME` 指定，脚本把它作为子进程 `HOME` 传给 wrangler。**仓库里不出现任何账号信息**（账号目录名、account id、token 都不进 git）。
- 内容页面全部服务端渲染（`output: "server"`），CMS 内容不用 `getStaticPaths()`。
- 遵循 EmDash 已知约束（见 [02-architecture.md §7](./02-architecture.md#7-核心约束与陷阱)）。
