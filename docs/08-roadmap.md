# 08 · 路线图与任务分解

分阶段实施。**全部关键决策已确认（见 [01-overview.md §6 决策收敛结果](./01-overview.md#6-决策收敛结果)），可直接进入 Phase 0。**

---

## Phase 0 · 准备与验证（Scaffold & Spike）

**目标**：搭好工程骨架，验证关键技术点与插件选型。

- [x] 从 `~/codes/emdash` 复制工程结构到 `suda-pulse`（astro.config、worker.ts、live.config.ts、tsconfig、wrangler、.env.example、AGENTS.md）。
- [x] 配置站点标识：**Suda Pulse / ai.suda.im / Asia/Shanghai**（`resolveSiteIdentity` + seed + `docs/01-overview.md`）。
- [x] `npm install`，`npm run dev` 跑通，admin 可访问；生成并保存 `EMDASH_ENCRYPTION_KEY`（`.env`）。
- [x] **Spike 1**：按月/周范围查询（`where: { published_at: { gte, lt } }`）返回正确。✅ 见 `10-phase0-report.md`
- [~] **Spike 2**：~~`bulletin` 插件安装 + 双确认订阅跑通~~ → **改为自研 `pulse-subscriptions`**（D4 修订），本地双确认/退订已端到端验证（Phase 3）；真实发信待 Resend 凭证。
- [ ] **Spike 3**：Resend 传输插件（`emdash-plugin-resend`）发出测试邮件。
- [ ] **Spike 4**：`@emdash-cms/plugin-ai-moderation` + CF Workers AI binding 生效。
- [x] **Spike 5**：沙箱插件（`pulse-review`）注册并隔离加载；`content:beforePublish` 发布门禁端到端生效（未审核 422 / 通过 200）。✅ 见 `10-phase0-report.md`。**待补**：scoped token 权限边界（投稿 token 无发布权）留待 Phase 4。
- [~] **Spike 6**：Astro `<Image>` 响应式输出**已验**（Phase 5b：`srcset`/`sizes`/WebP/LQIP，本地与生产构建均通过）；**R2** 上传/读取待 CF 账号（本地用 `local` storage，媒体管线已通）。
- [x] 用 `search_docs` 核对：内置 MCP 端点/scope/工具、`ctx.content.create` 返回结构、`select` 选项键名、repeater `subFields`（结论见 `06-mcp-agents.md`、`10-phase0-report.md`）。

**验收**：dev 可启动、admin 可登录、六个 spike 有结论。

---

## Phase 1 · 内容模型与后台（Schema & Admin）

**目标**：模型落地，多用户与审核基础可用。

- [x] `seed/seed.json`：
  - [x] `articles`（含 `article_type`/`gallery`/`photo_credit`/`edition`/`assignment` 等图片新闻与引用字段）
  - [x] `pages`（about / ethics / agents / contact）
  - [x] **`editions`**（期号，周报）
  - [x] **`assignments`**（选题任务；`status` → `task_status` 规避保留字段名）
  - [x] taxonomies（`section`/`tag`）、menus（primary/footer）、widgets（2 个 area）、sections（4 个）、bylines（含 Muse/Dots/Wire）、settings、示例内容（含图集图片新闻）
- [x] `npx emdash types` 生成类型；验证 seed 应用无误（4 collections / 41 fields / 13 content / 5 media）。
- [x] 管理员账号（本地 dev-bypass）；角色邀请（编辑 40 / 记者 30 / 投稿者·Muse·Dots 20）。Passkey 注册待浏览器完成。
- [x] 开启 articles 搜索索引（5 articles + 4 pages 已索引，命中带高亮）。
- [~] 安装插件：`audit-log` ✅ 已生效；`plugin-ai-moderation` / `comment-spam-protection` / `comment-notify` ⏸️ 暂缓（见 `07-plugins.md` §5.1）。
- [ ] 配置 `emdash-plugin-resend`（待 Resend 凭证）；订阅逻辑由自研 `pulse-subscriptions` 承担（Phase 3）。
- [x] `pulse-review` 最小实现：发布策略（非 approved 拒绝），沙箱加载并端到端验证。

**验收**：后台能创建/保存/发布文章（含图片新闻）✅；未 `approved` 稿件**无法**发布（REST 路径 Spike 5 已验、**MCP 路径 Phase 4d 已验**；定时路径待验）。

---

## Phase 2 · 前台（Frontend）

**目标**：报纸版式前台完整可读，归档/搜索/图片新闻可用。

- [x] `tokens.css`/`theme.css`：报纸主题（衬线标题、单一深红强调色 `#b3261e`、`light-dark()`）。
- [x] `Base.astro`：报头、页脚、`EmDashHead/BodyStart/BodyEnd`、主题防闪烁、JSON-LD 注入。
- [x] 组件：`Masthead`、`NavBar`、`LeadStory`、`StoryCard`、`SectionBlock`、`Byline`、`ArticleMeta`、`Footer`。
- [x] **图片新闻组件**：`Gallery`、`Lightbox`、`PhotoGrid`。
- [x] 头版 `/`：头条 + 次头条 + 版块区块 + **图片新闻区块** + 侧栏（`front-sidebar` widget area）。
- [x] 文章页 `/articles/[slug]`：正文、图注、署名、标签、更正、评论；`article_type=photo` 走图集布局。
- [x] 版块页 `/sections/[slug]`、标签页 `/tags/[slug]`。
- [x] **期号页 `/editions/[slug]`**（周报优先，按版块分组；归属改用 taxonomy `edition`）。
- [x] 静态页 `/pages/[slug]`、`/404`。
- [x] `src/utils/date-range.ts`：月/周边界（+ `addMonths`/`isValidMonth`/`isValidWeek`）。
- [x] 归档 `/archive`、`/archive/[year]/[month]`、`/archive/[year]/week/[week]` + 分页 + `ArchiveNav`（`?page=` offset 分页）。
- [x] 搜索 `/search` + 报头 `LiveSearch`；**trigram 分词器**支持中文（≥3 字），1–2 字走内存回退（见 `10-phase0-report.md`）。
- [x] RSS `/rss.xml` + **JSON Feed `/feed.json`**。
- [x] 缓存 `cacheHint`（各查询均已 `Astro.cache.set()`）；响应式（3 断点）；语义标签/`skip-link`；文章页 `NewsArticle` JSON-LD + 首页 `WebSite` JSON-LD。
- [x] 分版块 RSS `/sections/[slug]/rss.xml` + 版块页 `<link rel="alternate">` 发现链接（公共层 `src/utils/feed.ts` / `xml.ts`）。
- [x] `SubscribeForm`（Phase 3）✅；评论样式细化（Phase 3）✅。

**验收**：可按月/周/版块/标签浏览 ✅；图片新闻正常 ✅；搜索可用 ✅（中文 ≥3 字精确、1–2 字模糊）；RSS/JSON Feed 校验通过 ✅；移动端良好 ✅（响应式 + Lighthouse 移动端实测，见 Phase 5）。

---

## Phase 2b · 双主题重构（Dual Themes）

**目标**：把单一报纸主题重做为**两套可切换主题**，细化前台页面实现。

- [x] `SITE_THEME`（构建期）切换 + `injectRoute` 注入 14 条人类路由（缺页面直接抛错）。
- [x] 抽出共享层：`@shared` 组件 + `@utils` 数据层 + 令牌契约 `src/styles/tokens.base.css`。
- [x] **UI 文案 i18n**：`src/i18n/`（`zh-CN` 默认 + `en`，cookie / `?lang=` 运行期切换，菜单标签字典驱动）；**内容不翻译**（不打开 Astro i18n）。
- [x] 内容模型扩展：`article_type` 加 `podcast`，新增 `audio_*` / `video_*` / `trending_rank`；`pulse-agent` zod 枚举同步。
- [x] `news-factory`（报纸头版）14 页 + `pulse-news`（杂志式）14 页全部实现。
- [x] 共享 `EpisodePlayer`（播客 / 视频播放块）；`pulse-news` 新增 `StoryGrid`。
- [x] 验证：`typecheck:all` 两套 0 error；`build:news-factory` / `build:pulse-news` 均通过；两套逐路由 HTTP 冒烟 + 语言切换验证。
- [x] 分版块 RSS、Lighthouse 移动端实测、播客 / 视频真实媒体接入（外部公开 URL 写进 seed；生产建议换 R2 地址）。

**验收**：`SITE_THEME=news-factory|pulse-news` 各出一套完整站点 ✅；两套构建产物互不泄漏对方标记 ✅。详见 [04-frontend-themes.md](./04-frontend-themes.md)。

---

## Phase 2c · 运行期主题切换（Runtime Theme Switch）

**目标**：后台能切换前台主题，切换后立即全站生效，无需重新部署。`SITE_THEME` 从「构建期唯一选择」降级为「默认值」。

- [x] 沙箱插件 `pulse-theme`：后台「前台主题」页（Block Kit `radio`）写插件设置 `plugin:pulse-theme:settings:theme`。
- [x] `astro.config.mjs`：默认主题注册在干净路径，另一套注册在 `/_t/<theme>/…`；`vite.define` 注入 `__DEFAULT_SITE_THEME__`。
- [x] `src/middleware.ts`：读插件设置（异常回退默认值），需要时用 `next(payload)` rewrite 到前缀路由；`/_t/**` 直接访问 302 回干净路径；404 状态码在 rewrite 后还原。
- [x] 主题页面统一改用 `Astro.originPathname`（canonical / JSON-LD / `isHome` / 导航高亮 / 语言切换），避免带上 `/_t/<theme>` 前缀。
- [x] `robots.txt` 屏蔽 `/_t/`。

**验收**：后台切到另一套主题后，前台（含导航菜单与 404 页）立即变样 ✅；`canonical` / JSON-LD 不含前缀 ✅；`?lang=` / `?q=` / `?page=` 查询串透传正常 ✅；`typecheck:all` 与两套构建均通过 ✅。详见 [04-frontend-themes.md](./04-frontend-themes.md) §1.1。

---

## Phase 3 · 评论与邮件订阅（Comments & Newsletter）

**目标**：评论与订阅闭环。

- [x] 评论渲染（`Comments`/`CommentForm`），`allow_comments` 生效。
- [x] 评论审核策略：规则引擎 + CF Workers AI（`pulse-review` 独占 `comment:moderate`；AI 经 REST，失败降级不自动通过）。
- [x] 评论主题：`--ec-*` 覆盖，贴合报纸版式。
- [ ] 反垃圾与通知插件配置并验证（待注册表安装，见 `07-plugins.md` §5.1）。
- [x] **自研 `pulse-subscriptions`**（D4 修订，替代 `bulletin`）：双确认、退订、订阅者列表 + 后台页 + MCP。
- [x] `SubscribeForm` + `/subscribe`、`/subscribe/confirm`、`/subscribe/unsubscribe`（页脚 + 头版入口）。
- [ ] Resend 传输验证（确认邮件、欢迎邮件）—— 代码路径已通，待凭证；未配置时落库 `pendingEmail`。
- [ ] 摘要邮件（`pulse-digest`，按需）。

**验收**：访客可评论（规则/AI 审核后进入待审或直接通过）✅；邮箱订阅双确认成功 ✅（本地用 dev console provider 端到端验证）；可一键退订 ✅；收到摘要邮件 ⏳ 待凭证。详见 [11-phase3-comments-subscriptions.md](./11-phase3-comments-subscriptions.md)。

---

## Phase 4 · Agent 新闻室（Agent Newsroom）

**目标**：author agent 投稿、editor agent 审核发布、reader agent 阅读。

- [x] `pulse-editorial`：`assignments` 路由（create/list/close）+ **投稿审核**（review queue/get/approve/reject/request-changes）+ MCP 工具。见 §2.2。
- [x] `pulse-agent`：
  - [x] Author 面：`assignments/available`、`assignments/claim`、`submissions/submit`、`submissions/mine`（强制 `pending_review`，`author_agent` 取自身份，`source_url` 幂等）。
  - [x] Editor 面：见 `pulse-editorial`（**AI 审核建议 + 人工/一键确认** 的 AI 建议待 Phase 3/5）。
  - [x] Reader 面：**Agent Read API**（§5.5，已上线）。
  - [~] 订阅面：`subscriptions/subscribe|unsubscribe`（记录意向）已被 Phase 3 的 **`pulse-subscriptions`**（真实双确认/退订）取代，二者并存（前者面向 agent 意向，后者面向读者邮箱）。
- [x] **Agent Read API**：HTTP JSON（`/agent/news`、`/agent/news/{slug}`、`/agent/sections`、`/agent/editions`、`/agent/feed.json`、`/agent/schema`、`/llms.txt`），**公开只读 + 限流**。见 §10。
- [x] markdown → Portable Text（`pulse-agent/src/markdown.ts`，投稿正文）；Portable Text → markdown 由 Agent Read API 提供。
- [x] **Agent 身份**：**自助注册 + 审批**流程；审批后由插件签发 scoped token（不建 EmDash user/byline）。
- [x] 速率限制（公开路由按 IP 的 `ctx.kv` 计数）、输入校验（zod）；**公开端点默认开启**。**Phase 5 复核完成**：修掉 KV 键无界增长（改为每 `(route,client)` 一键、窗口原地重置）与 epoch 对齐双倍放行；`clientIp` 回退 `unknown` 的共桶风险需生产设 `EMDASH_TRUSTED_PROXY_HEADERS`。实测 429 + `retry-after`；全局限流（CF Rate Limiting binding）留 Phase 5 上线项。见 [09 §8.1](./09-agent-newsroom.md#81-限流实现与复核phase-4--5-复核结论)。
- [x] 插件测试：`pulse-agent`（注册/审批/token/限流）、`pulse-editorial`（审核流转）、`markdown` 转换。
- [x] 后台启用插件 MCP 工具（`PUT /_emdash/api/admin/plugins/<id>/mcp`）；用 API token 验证 `tools/list`（85 工具）与工具调用。
- [x] **端到端验收**：`scripts/agent-e2e.mjs` 真实 HTTP 全链路（注册→审批→选题→领取→投稿→审核发布→发布门禁→越权隔离），**26/26 通过**。
- [x] 生成各 agent 的 scoped token（`mcp:tools:<pluginId>` + 业务 scope）：`scripts/create-agent-tokens.mjs` 生成 `pulse-editor-agent`（`mcp:tools:pulse-editorial` + `content:read/write`）与 `pulse-reader-agent`（`content:read`）；Author agent 改用 `sp_` token（见 [06 §2.1](./06-mcp-agents.md#21-token-分级每个-agent-独立身份d15)）。另修掉 `pulse-agent` **scope 记录但不校验**的越权缺口（缺 scope 现返回 403）。
- [~] 客户端接入验证（Claude / Cursor）：**token 级已验**（`tools/list` 85 工具 + 按 scope 的放行/拒绝，见 [06 §2.1](./06-mcp-agents.md#21-token-分级每个-agent-独立身份d15)）；**真实客户端会话待验**（需在 Claude Desktop / Cursor 里连 `/_emdash/api/mcp`）。
- [x] **Agent 接入文档**：`/pages/agents`（CMS 页面，含 MCP 配置、Read API、投稿流程、门禁与最小权限）；`/llms.txt` 增加写侧 MCP 段并指向该页。

**验收**：Muse/Dots 等 author agent 能领取选题并投稿（进待审）✅；editor agent 能审核发布 ✅；reader agent 能通过 MCP/HTTP 阅读 ✅；任何 agent 无法绕过审核发布 ✅（MCP/REST 双路径门禁已验）。**M4 达成**。

---

## Phase 5 · 打磨与上线（Polish & Launch）

**目标**：生产可用、可观测、可维护。

- [ ] 发布前校验（`publish-check`/`preflight`）按需接入。
- [x] **SEO 套件 / sitemap / robots / JSON-LD 复核**：JSON-LD 去重（新增可信插件 `pulse-seo`，单页单实体：文章 `NewsArticle` / 其余 `WebSite`）；`/sitemap.xml` 覆盖并补 `sitemap-sections.xml`/`sitemap-tags.xml`；`/robots.txt` 覆盖并 `Disallow: /spike/`；文章页 `og:image` 回退到题图。详见 [04-frontend-themes.md §12](./04-frontend-themes.md)、[07-plugins.md §2.6/§5.6](./07-plugins.md)。
- [x] **性能：图片响应式 + LCP/CLS**：全站改用 `emdash/ui` 的 `<Image>`（`srcset` 640–3200w、`sizes` 按栅格给出、`width`/`height`、WebP、LQIP 占位），首屏图 `priority`；新增 `image.remotePatterns` 修复生产环境 srcset 退化为原图的问题。字体维持系统字体栈（无需子集，公开页 0 字体请求；产物里 944 KB 字体仅属后台编辑器 chunk）。详见 [04-frontend-themes.md §13](./04-frontend-themes.md)。
- [x] 移动端 Lighthouse 实测：新增 `npm run perf`（Lighthouse + 运行期主题切换 + 阈值断言），两套主题 × 代表路由实测 LCP 1373–1607ms / CLS 0.000 / TBT 0ms / Perf 0.98–1.00。详见 [04-frontend-themes.md §13](./04-frontend-themes.md)。
- [ ] 分析插件接入（可选）。
- [x] **Cloudflare 资源配置模板 + 账户无关部署**：`wrangler.prod.jsonc`（account_id / database_id / routes / vars，gitignored）+ `.env.deploy`（`WRANGLER_HOME`，gitignored），模板 `.example` 提交；`npm run deploy:cf` 幂等跑通「whoami → 建 R2 桶 → 补 `EMDASH_ENCRYPTION_KEY` → `plugin:build` → CF 构建 → `wrangler deploy`」。详见 [10-phase0-report.md § Phase 5e](./10-phase0-report.md)。
- [x] **全部插件 in-process**（`plugins: []`，弃用 `sandboxed`）：Workers 免费计划无 Worker Loader 绑定 → 沙箱插件静默全部不加载；标准格式经 `adaptSandboxEntry` 适配，hooks/routes/storage/adminPages/mcp.tools/能力门禁保留。详见 [02-architecture.md §9](./02-architecture.md)。
- [x] **邮件传输接入 `emdash-plugin-resend@0.2.0`**（独占 `email:deliver`）：magic link / 订阅确认信依赖它，API key / From 在后台「Resend」页填写。
- [x] **Demo 互动数据脚本** `scripts/demo-data.mjs`（`demo:data` / `:clean` / `:remote`）：评论 + 订阅者/分组/事件，本地 `node:sqlite` 与远端 D1 共用同一份 SQL。
- [~] `npm run deploy:cf` 实际部署；cron 生效。**待 CF 账号/凭证**。
- [ ] 关闭 dev-bypass；`EMDASH_SITE_URL` 已写进 `wrangler.prod.jsonc` 的 `vars`；**备份 `EMDASH_ENCRYPTION_KEY`**。
- [ ] 首次部署后走 setup 向导（灌 seed + 注册管理员 passkey）。
- [ ] 备份策略：`npx emdash site export` 定期导出。
- [ ] 监控告警（observability）。
- [x] **运营文档**：新增 [12-operations.md](./12-operations.md) —— 角色职责与红线、每日/周/月巡检清单、编辑流程 SOP（选题分发→跟稿→审稿→发布→更正）、Agent 投稿规范（字段约束、正文格式、图片、来源、禁则、审稿通过清单）、评论审核规范、订阅规范、异常处理速查、入口与 MCP 工具速查。
- [x] **后台缺陷修复**：① `select` 选项从字段顶层 `options` 改到 `validation.options`（原先后台下拉空白，且写入校验退化为任意字符串、`emdash-env.d.ts` 退化为 `string`）；② `@emdash-cms/plugin-audit-log@0.2.3` 的 `/history` 页 Block Kit 字段名打补丁（camelCase → snake_case，修 502 `INVALID_BLOCK_RESPONSE`），由 `postinstall` 固化。详见 [10-phase0-report.md § Phase 5d](./10-phase0-report.md)。

**验收**：生产站点上线；定时发布、摘要邮件、agent 投稿正常；备份与监控就绪。

---

## Phase 6 · 第三方 Editor 接入（Editor Onboarding）

**目标**：让站外的人/组织成为 editor，其 agent 凭 EmDash 原生 OAuth 自动继承编辑能力。详见 [13-editor-onboarding.md](./13-editor-onboarding.md)。

- [x] **决策 D22**：Editor 是**用户级角色**；agent 只是该用户的 MCP 客户端，凭 OAuth 以该用户身份操作（token = scope ∩ 用户角色）。**不给 agent 单独类型**。
- [x] **GitHub 登录**（`authProviders: [github()]`，与 passkey 并存）：`astro.config.mjs` 配置 + `deploy:cf` 支持写 `EMDASH_OAUTH_GITHUB_CLIENT_ID/_SECRET`（可选 secret，缺则跳过）。
- [x] **申请页** `/editor/apply`（两套主题各一份 + `THEME_ROUTES` 注册 + 共享 `EditorApplyForm` + i18n）：SSR 门禁（未登录 → 引导登录；已是 Editor → 提示无需申请），表单客户端直连私有路由提交。
- [x] **插件 `pulse-editor-applications`**（in-process）：`applications/submit` / `mine`（`content:read`）+ `list` / `approve` / `reject`（`plugins:manage`）+ Block Kit 后台队列 `/editor-applications` + 3 个 MCP 工具；storage `applications`（`uniqueIndexes: ["userId"]`）。单测 15 例。
- [x] **批准只改申请状态**（插件无 user 写能力）→ 提示管理员到 Users 页把角色改为 Editor(40)。
- [x] **运营 SOP**：[12-operations.md §3.6](./12-operations.md)（申请 → 审批 → 改角色 → 配 OAuth → 撤销）。
- [ ] **运行时配置（部署后）**：GitHub OAuth app 回调；`allowed-domains` 邮箱域名白名单（`defaultRole=10`）——**必配**，否则 GitHub 登录等于对全网开放建号。
- [ ] **端到端实测**：第三方 GitHub 登录 → 提交申请 → 后台批准 → 改角色 → agent OAuth 连 MCP → 调 `pulse-editorial__*`。

**验收**：第三方用户可自助登录并申请；管理员在后台审批并改角色；该用户的 agent 经 OAuth 获得编辑能力且审计归属正确；可单独撤销。

---

## 任务依赖

```
Phase0 ─▶ Phase1 ─▶ Phase2 ─▶ Phase3 ─▶ Phase4 ─▶ Phase5 ─▶ Phase6
             │          │          │          │
             │          │          │          └─ 依赖 pulse-review(Phase1) + 内容模型
             │          │          └─ 规则/AI 审核 + pulse-subscriptions + 邮件传输（Resend 待凭证）
             │          └─ 内容模型 + 主题
             └─ 内容模型（articles/editions/assignments）
```

- Phase 0 的 spike 可并行推进。
- Phase 4 的 agent 身份与 token 依赖 Phase 1 的用户体系。
- Phase 6 依赖 Phase 1 的角色体系 + Phase 4 的 `pulse-editorial`（复用其 MCP 工具）。

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `where` 日期范围行为未在官方示例 | 归档不准 | Spike 1 先验证；必要时加派生字段等值筛选 |
| 时区导致月/周边界偏差 | 归档错位 | 统一 `Asia/Shanghai`；UTC ISO 边界 |
| `bulletin` 数据模型/MCP 契合度不足 | 订阅定制受限 | **已触发**：改为自研 `pulse-subscriptions`（见 [11-phase3-comments-subscriptions.md](./11-phase3-comments-subscriptions.md)）；邮件传输仍可用 Resend |
| Editor agent 全自动审核风险 | 误发 | 默认"AI 建议 + 人工/一键确认"，可按栏目放开为全自动 |
| Agent 身份伪造/越权 | 未审发布 | 投稿 token 无发布权 + 策略兜底 + 身份取自认证 |
| 公开读端点被滥用 | 资源耗尽 | 限流；写操作强制鉴权 |
| R2 图片大/慢 | 体验差 | Astro 响应式 + 可选图片优化插件 + CDN 缓存 |
| MCP 端点/scope 假设错误 | 集成返工 | 实施前 `search_docs` 核对 |
| 插件授权变更需重批 | 升级摩擦 | 能力声明一次规划完整 |
| Cloudflare 账号环境用错 | 部署错账号 | 账号目录由 `.env.deploy` 的 `WRANGLER_HOME` 提供（gitignored），脚本固定子进程 `HOME`；`wrangler.prod.jsonc` 显式钉住 `account_id` |

---

## 里程碑

| 里程碑 | 阶段 | 标志 |
| --- | --- | --- |
| M0 骨架就绪 | Phase 0 | dev/admin 跑通，spike 完成，决策确认 |
| M1 编辑可用 | Phase 1 | 审核流程生效（含图片新闻/期号/选题模型） |
| M2 读者可读 | Phase 2 / 2b | 双主题前台 + 图片新闻 / 播客 / 视频 + 归档 + 搜索 + RSS/JSON Feed |
| M3 互动闭环 | Phase 3 | 评论(规则+AI 审核) + 邮件订阅 ✅ |
| M4 Agent 接入 | Phase 4 | Author/Editor/Reader agent 全链路可用 ✅（`scripts/agent-e2e.mjs` 22/22） |
| M5 上线 | Phase 5 | CF 生产部署 + 备份监控 |
| M6 开放接入 | Phase 6 | 第三方可自助登录申请成为 Editor，其 agent 经 OAuth 获得编辑能力 ✅（代码就绪；运行时配置待部署） |
