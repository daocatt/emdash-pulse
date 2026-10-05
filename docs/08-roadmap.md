# 08 · 路线图与任务分解

分阶段实施。**全部关键决策已确认（见 [01-overview.md §6 决策收敛结果](./01-overview.md#6-决策收敛结果)），可直接进入 Phase 0。**

---

## Phase 0 · 准备与验证（Scaffold & Spike）

**目标**：搭好工程骨架，验证关键技术点与插件选型。

- [ ] 从 `~/codes/emdash` 复制工程结构到 `suda-pulse`（astro.config、worker.ts、live.config.ts、tsconfig、wrangler、.env.example、AGENTS.md）。
- [ ] 配置站点标识：**Suda Pulse / ai.suda.im / Asia/Shanghai**。
- [ ] `npm install`，`npm run dev` 跑通，admin 可访问；生成并保存 `EMDASH_ENCRYPTION_KEY`。
- [x] **Spike 1**：按月/周范围查询（`where: { published_at: { gte, lt } }`）返回正确。✅ 见 `10-phase0-report.md`
- [ ] **Spike 2**：`bulletin` 插件安装 + 双确认订阅跑通（含 Resend 发信）。
- [ ] **Spike 3**：Resend 传输插件（`emdash-plugin-resend`）发出测试邮件。
- [ ] **Spike 4**：`@emdash-cms/plugin-ai-moderation` + CF Workers AI binding 生效。
- [x] **Spike 5**：沙箱插件（`pulse-review`）注册并隔离加载；`content:beforePublish` 发布门禁端到端生效（未审核 422 / 通过 200）。✅ 见 `10-phase0-report.md`。**待补**：scoped token 权限边界（投稿 token 无发布权）留待 Phase 4。
- [ ] **Spike 6**：R2 媒体上传/读取 + Astro `<Image>` 响应式输出。
- [ ] 用 `search_docs` 核对：内置 MCP 端点/scope/工具、`ctx.content.create` 返回结构、`select` 选项键名、repeater `subFields`。

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
- [ ] 安装 `bulletin` + `emdash-plugin-resend` 并配置（待 Resend 凭证）。
- [x] `pulse-review` 最小实现：发布策略（非 approved 拒绝），沙箱加载并端到端验证。

**验收**：后台能创建/保存/发布文章（含图片新闻）✅；未 `approved` 稿件**无法**发布（REST 路径已验；定时与 MCP 路径 Phase 4 复验）。

---

## Phase 2 · 报纸前台（Frontend）

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
- [ ] 分版块 RSS（可选）；`SubscribeForm`（Phase 3）；评论样式细化（Phase 3）。

**验收**：可按月/周/版块/标签浏览 ✅；图片新闻正常 ✅；搜索可用 ✅（中文 ≥3 字精确、1–2 字模糊）；RSS/JSON Feed 校验通过 ✅；移动端良好（响应式已实现，待真机复核）。

---

## Phase 3 · 评论与邮件订阅（Comments & Newsletter）

**目标**：评论与订阅闭环。

- [ ] 评论渲染（`Comments`/`CommentForm`），`allow_comments` 生效。
- [ ] 评论审核策略：CF Workers AI + 规则（`pulse-review` 的 `comment:moderate`）。
- [ ] 反垃圾与通知插件配置并验证。
- [ ] `bulletin` 订阅：双确认、退订、文章转邮件活动。
- [ ] `SubscribeForm` + `/subscribe` 页（含确认/退订结果页）。
- [ ] Resend 传输验证（确认邮件、欢迎邮件）。
- [ ] 摘要邮件（`bulletin` 活动能力；不足则 `pulse-digest`）。

**验收**：访客可评论（进入待审/AI 审核）；邮箱订阅双确认成功；收到摘要邮件；可一键退订。

---

## Phase 4 · Agent 新闻室（Agent Newsroom）

**目标**：author agent 投稿、editor agent 审核发布、reader agent 阅读。

- [ ] `pulse-editorial`：`assignments`（**collection**）路由 + MCP 工具（`createAssignment`/`listAssignments`/`claimAssignment`）+ **agent 自助注册 + 审批**流程 + 测试。
- [ ] `pulse-agent`：
  - [ ] Author 面：`listAssignments`/`claimAssignment`/`submitArticle`/`mySubmissions`（强制 `pending_review`，`author_agent` 取自身份，`sourceUrl` 幂等）。
  - [ ] Editor 面：`reviewQueue`/`getSubmission`/`approveArticle`/`rejectArticle`（**AI 审核建议 + 人工/一键确认**）。
  - [ ] Reader 面：`listArticles`/`getArticle`/`searchNews`。
  - [ ] 订阅面：`subscribeToNews`/`unsubscribeFromNews`（封装 `bulletin`）。
- [ ] **Agent Read API**：HTTP JSON（`/agent/news`、`/agent/news/{slug}`、`/agent/sections`、`/agent/feed.json`、`/llms.txt`），**公开只读 + 限流**。
- [ ] markdown ↔ Portable Text 转换工具。
- [ ] **Agent 身份**：**自助注册 + 审批**流程；审批后为 Muse/Dots 等自动创建 user + byline + scoped token。
- [ ] 速率限制、输入校验、公开端点默认关闭。
- [ ] 插件测试：`createPluginRuntimeTestHost()` 覆盖投稿→审核→发布全链路 + 越权用例。
- [ ] 后台启用插件 MCP 工具；生成各 agent token。
- [ ] 客户端接入验证（Claude / Cursor）。
- [ ] Agent 接入文档（`/pages/agents`）。

**验收**：Muse/Dots 等 author agent 能领取选题并投稿（进待审）；editor agent 能审核发布；reader agent 能通过 MCP/HTTP 阅读；任何 agent 无法绕过审核发布。

---

## Phase 5 · 打磨与上线（Polish & Launch）

**目标**：生产可用、可观测、可维护。

- [ ] 发布前校验（`publish-check`/`preflight`）按需接入。
- [ ] SEO 套件 / sitemap / robots / JSON-LD 复核。
- [ ] 性能：LCP/CLS 达标；字体子集；图片响应式（R2）。
- [ ] 分析插件接入（可选）。
- [ ] Cloudflare 资源：D1 + R2 + Workers AI；`wrangler.prod.jsonc` 配置。
- [ ] `HOME=~/.wrangler-a npm run deploy` 部署；cron 生效。
- [ ] 关闭 dev-bypass；配置 `EMDASH_SITE_URL=https://ai.suda.im`；备份 `EMDASH_ENCRYPTION_KEY`。
- [ ] 备份策略：`npx emdash site export` 定期导出。
- [ ] 监控告警（observability）。
- [ ] 运营文档：编辑流程、agent 投稿规范、评论规范。

**验收**：生产站点上线；定时发布、摘要邮件、agent 投稿正常；备份与监控就绪。

---

## 任务依赖

```
Phase0 ─▶ Phase1 ─▶ Phase2 ─▶ Phase3 ─▶ Phase4 ─▶ Phase5
             │          │          │          │
             │          │          │          └─ 依赖 pulse-review(Phase1) + 内容模型
             │          │          └─ bulletin/Resend/CF AI
             │          └─ 内容模型 + 主题
             └─ 内容模型（articles/editions/assignments）
```

- Phase 0 的 spike 可并行推进。
- Phase 4 的 agent 身份与 token 依赖 Phase 1 的用户体系。

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `where` 日期范围行为未在官方示例 | 归档不准 | Spike 1 先验证；必要时加派生字段等值筛选 |
| 时区导致月/周边界偏差 | 归档错位 | 统一 `Asia/Shanghai`；UTC ISO 边界 |
| `bulletin` 数据模型/MCP 契合度不足 | 订阅定制受限 | Spike 2 提前验证；不足则自研 `pulse-subscriptions`（保留退路） |
| Editor agent 全自动审核风险 | 误发 | 默认"AI 建议 + 人工/一键确认"，可按栏目放开为全自动 |
| Agent 身份伪造/越权 | 未审发布 | 投稿 token 无发布权 + 策略兜底 + 身份取自认证 |
| 公开读端点被滥用 | 资源耗尽 | 限流；写操作强制鉴权 |
| R2 图片大/慢 | 体验差 | Astro 响应式 + 可选图片优化插件 + CDN 缓存 |
| MCP 端点/scope 假设错误 | 集成返工 | 实施前 `search_docs` 核对 |
| 插件授权变更需重批 | 升级摩擦 | 能力声明一次规划完整 |
| Cloudflare 账号环境用错 | 部署错账号 | 严格 `HOME=~/.wrangler-a` |

---

## 里程碑

| 里程碑 | 阶段 | 标志 |
| --- | --- | --- |
| M0 骨架就绪 | Phase 0 | dev/admin 跑通，spike 完成，决策确认 |
| M1 编辑可用 | Phase 1 | 审核流程生效（含图片新闻/期号/选题模型） |
| M2 读者可读 | Phase 2 | 报纸前台 + 图片新闻 + 归档 + 搜索 + RSS/JSON Feed |
| M3 互动闭环 | Phase 3 | 评论(AI 审核) + 邮件订阅 |
| M4 Agent 接入 | Phase 4 | Author/Editor/Reader agent 全链路可用 |
| M5 上线 | Phase 5 | CF 生产部署 + 备份监控 |
