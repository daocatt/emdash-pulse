# 01 · 项目概述

## 1. 项目定位

**Suda Pulse**（`pulse.suda.im`）是一套面向**新闻编辑室 / 报刊 / 独立媒体**、**以 Agent 协作生产为核心**的发布系统：

- **前台**：**双主题**阅读体验（`news-factory` 报纸头版 / `pulse-news` 杂志式，默认值 `SITE_THEME`、后台「前台主题」页可运行期切换），支持按**月 / 周**浏览归档，支持全文搜索，UI 文案支持中文 / 英文。
- **后台**：基于 EmDash 内置管理后台，提供内容审核（编审流程）、多用户协作、分类与标签、评论审核。
- **Agent 新闻室**：**Author agent**（如 Muse、Dots 等）生产新闻，**Editor agent** 负责审核与发布；编辑向 author agent **分发选题/任务**。
- **双阅读面**：既提供人类阅读的**双主题前台 UI**，也提供**Agent Read API**（MCP + HTTP JSON）供 agent 阅读。
- **分发**：RSS / JSON Feed、邮件订阅（newsletter）。
- **自动化**：MCP 使 agent 能提交新闻、订阅新闻、**阅读新闻**。

技术底座复用 EmDash（Astro 原生、TypeScript 全栈 CMS），**不 fork core**，通过 schema + 主题 + 插件扩展实现。

### 站点标识
| 项 | 值 |
| --- | --- |
| 站点名 | **Suda Pulse** |
| 域名 | **pulse.suda.im** |
| 时区 | **Asia/Shanghai**（影响月/周归档边界） |
| 语言 | zh-CN（UI 文案支持 zh-CN / en 运行期切换；内容不翻译） |
| 部署 | VPS 独立部署：Node + PostgreSQL + Redis + Docker 三容器（宿主反代终止 TLS） |

---

## 2. 参与者与角色

### 2.1 人类角色（EmDash 内置 RBAC）
| 角色 | 对应 EmDash | 职责 |
| --- | --- | --- |
| 读者 | Subscriber | 阅读、评论、订阅 |
| 投稿者 | Contributor | 提交**待审**稿件，不能发布 |
| 记者 | Author | 撰写稿件，**提交审核**（新闻社强制审核） |
| 编辑 | Editor | 审核/通过/驳回、发布、管理分类/标签/菜单/评论、**创建选题任务** |
| 管理员 | Admin | 用户、插件、设置、内容模型、备份、站点导入导出 |

### 2.2 Agent 角色（本项目的核心）
| Agent 类型 | 示例 | 映射 | 权限 | 职责 |
| --- | --- | --- | --- | --- |
| **Author agent** | Muse、Dots、… | 独立身份 + Contributor 权限 | `content:write`（仅 articles） | 领取选题、生产并**提交待审**新闻 |
| **Editor agent** | （可配置） | 独立身份 + Editor 权限 | `content:publish`、`content:read` | 审核队列、通过/驳回、发布/定时 |
| **Reader agent** | 任意 MCP/HTTP 客户端 | 无需登录 | 只读公开 API | 通过 Agent Read API 阅读新闻 |

- 每个 author agent 拥有**独立身份**（byline + 专属 scoped token），便于审计与限流。
- Author agent **无法直接发布**：投稿强制进入 `pending_review`，发布由 Editor（人或 agent）执行。

---

## 3. 范围（In Scope）

1. **内容模型**：文章（articles）、静态页（pages）、**期号（editions）**、**选题任务（assignments）**。
2. **编审工作流**：草稿 → 待审 → 通过/驳回 → 发布/定时发布（含 Author agent 稿件）。
3. **Agent 新闻室**：选题分发 → author agent 领取/投稿 → editor agent 审核/发布。
4. **Agent Read API**：MCP 工具 + HTTP JSON API（含 JSON Feed）。
5. **多用户与权限**：人类角色 + agent 身份、编辑锁、修订、预览。
6. **前台双主题**：`news-factory`（报纸头版）与 `pulse-news`（杂志式），各含头版、版块页、文章页、归档页、搜索页、订阅页；默认主题由构建期 `SITE_THEME` 决定，运行期可在后台「前台主题」页切换。
7. **归档筛选**：按月、按周。
8. **分类与标签**：hierarchical `section` + flat `tag`。
9. **评论**：内置评论 + **AI 语义审核**（经自研 `pulse-ai` 网关）+ 反垃圾。
10. **RSS / JSON Feed**：全站与分版块。
11. **邮件订阅**：**自研 `pulse-subscriptions`**（双确认、退订、订阅者管理；D4 修订），**Resend** 传输。
12. **部署**：**VPS 独立部署**（Node standalone + PostgreSQL + Redis + Docker 三容器；媒体本地磁盘或 S3 兼容）。

## 4. 非目标（Out of Scope，本期不做）

- 广告系统、付费墙 / 会员付费。
- 原生移动 App。
- **内容多语言 / 内容翻译**（UI 文案已支持 zh-CN / en；**内容本身不翻译**）。
- 实时协同编辑。
- 自建邮件投递基础设施（用 Resend）。

---

## 5. 关键决策（ADR）

| # | 决策 | 理由 | 状态 |
| --- | --- | --- | --- |
| D1 | 基于 EmDash 扩展，**不 fork core** | 保留升级路径与安全模型 | ✅ |
| D2 | 内容主类型 `articles`，`urlPattern=/articles/{slug}` | 语义贴合新闻 | ✅ |
| D3 | 审核 = 草稿 + `review_status` 字段 + 发布策略 hook | 原生"保存≠发布" + `content:beforePublish` 强制 | ✅ |
| D4 | 邮件订阅**自研 `pulse-subscriptions`**（原定社区 `bulletin`） | 需要自有订阅表与 Agent 订阅意向对齐；本地可完整验证数据流 | 🔁 已修订 |
| D5 | 邮件传输采用 **Resend** | 送达率好、API 简单 | ✅ 已定 |
| D6 | MCP 复用内置 + 自研 `pulse-agent` 插件 | 内置管内容，自研管投稿/订阅/阅读/审核 | ✅ |
| D7 | 生产部署 **VPS + Docker 三容器**（Node + PostgreSQL + Redis；媒体 S3 兼容或本地） | 数据自主、AI 供应商自由、无按行计费配额；见 D23 | 🔁 已修订 |
| D8 | 按月/周筛选用 `where.published_at` 范围（`gte`/`lt`） | 已确认 `WhereRange` 支持 | ✅ |
| D9 | 主题从零自研（**双主题**：报纸头版 + 杂志式） | 与朋友圈主题差异大；两套 UI 稿需共存 | ✅ |
| D10 | 自研插件走**标准格式**、统一 `plugins: []`（in-process） | 权限可声明；本地与生产同路径（沙箱后端在 CF 上需付费计划） | 🔁 已修订 |
| D11 | **Author 稿件强制审核**（含人类 Author） | 新闻社编审要求 | ✅ 已定 |
| D12 | 引入**显式期号 `editions`** | 编辑可控版面打包 | ✅ 已定 |
| D13 | 引入 **Agent Read API**（MCP + HTTP JSON） | agent 阅读与聚合需求 | ✅ 已定 |
| D14 | 评论 AI 审核走自研 **`pulse-ai` 网关**（provider 可换：CF AI Gateway / OpenAI / Anthropic / 任意兼容端点） | 不绑死单一供应商，成本可控 | 🔁 已修订 |
| D15 | 每个 author agent **独立身份 + scoped token** | 审计、限流、归属清晰 | ✅ 已定 |
| D16 | 选题分发用 **`assignments` collection** | 显式任务流转，后台可视化编辑，agent 可领取 | ✅ 已定 |
| D17 | Editor agent **产出审核建议 + 人工/一键确认**（可配置全自动） | 风险可控，兼顾效率 | ✅ 已定 |
| D18 | Author agent **自助注册 + 审批** | 便于扩展 agent 生态 | ✅ 已定 |
| D19 | Agent Read API **公开只读 + 限流** | 便于任意 agent 接入 | ✅ 已定 |
| D20 | 期号先做 **周报（week）**，月报后续可加 | 粒度贴合新闻节奏 | ✅ 已定 |
| D21 | 评论 **AI 审核为主，人工后期干预** | 效率与可控平衡 | ✅ 已定 |
| D22 | 第三方 editor 接入 = **EmDash Editor 用户 + GitHub OAuth**（不给 agent 单独类型） | agent 以用户身份操作，能力 = scope ∩ 角色 | ✅ 已定 |
| D23 | 运行时从 Cloudflare Workers 迁到 **Node standalone**；库 **PostgreSQL**；缓存 **Redis**；AI 走 `pulse-ai`；订阅同步 Resend **Segments**、群发 **Broadcasts** | 中文全文搜索、AI 供应商自由、数据自主、无按行配额 | ✅ 已定 |

---

## 6. 决策收敛结果

**全部关键决策已确认**（D1–D23，见 §5），无剩余阻塞项。

| 项 | 结论 |
| --- | --- |
| 选题载体 | **`assignments` collection**（后台可视化编辑 + API） |
| Editor agent | **AI 审核建议 + 人工/一键确认**（可配置全自动） |
| Author agent 接入 | **自助注册 + 审批** |
| Agent Read API | **公开只读 + 限流**（写操作鉴权） |
| 期号粒度 | **周报优先**（`period_type=week`），月报后续 |
| 评论策略 | **AI 审核为主，人工后期干预**（AI 经 `pulse-ai` 网关） |
| 邮件订阅 / 传输 | **`pulse-subscriptions`**（自研）+ **Resend**（Segments 同步 / Broadcasts 群发） |
| 审核 | Author（人类 + agent）**强制审核** |
| 站点 / 部署 | Suda Pulse · pulse.suda.im · Asia/Shanghai · VPS（Node + PostgreSQL + Redis + Docker 三容器） |

> 次要选择（分析插件、SEO 套件、限流阈值、月报）在对应 Phase 内决策，不阻塞实施。

---

## 7. 成功标准（Definition of Done）

- [ ] 读者可按月、按周、按版块、按标签浏览，并全文搜索。
- [ ] 编辑可创建选题任务并分发给指定 author agent。
- [ ] Author agent（Muse/Dots 等）可领取选题、提交稿件（进入待审），**无法直接发布**。
- [ ] Editor agent / 编辑可审核、通过/驳回、发布/定时发布。
- [ ] 人类通过双主题前台 UI 阅读；agent 通过 MCP / HTTP JSON API 阅读已发布新闻。
- [ ] RSS / JSON Feed 可订阅；邮件订阅完成双确认与退订。
- [ ] 评论经 AI（`pulse-ai`）+ 人工审核。
- [ ] 生产部署到 VPS（Node + PostgreSQL + Redis，Docker 三容器），定时任务正常。
