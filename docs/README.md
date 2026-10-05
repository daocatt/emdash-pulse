# Suda Pulse — 报刊发布系统规划文档

> 基于 [EmDash CMS](https://github.com/emdash-cms/emdash) + [Astro](https://astro.build/) 构建的 **AI 时代新闻 / 报刊发布系统**。
> 前台报纸版式，后台内容审核 + 多用户，**Author agent 生产 / Editor agent 审核发布**，双阅读面（报纸 UI + Agent API），支持图片新闻、RSS、邮件订阅。

**站点**：Suda Pulse · `ai.suda.im` · `Asia/Shanghai` · 部署于 Cloudflare（D1 + R2 + Workers AI）。

本目录是**实施前的规划与任务文档**。请先审阅并确认，确认后再进入编码阶段。

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [01-overview.md](./01-overview.md) | 愿景、范围/非目标、角色（含 Agent）、关键决策（ADR）、决策收敛结果 |
| [02-architecture.md](./02-architecture.md) | 技术栈、架构、R2 图片管线、部署、核心约束 |
| [03-content-model.md](./03-content-model.md) | collections/fields/taxonomies/menus/widgets/seed（含图片新闻、期号、选题） |
| [04-frontend-newspaper.md](./04-frontend-newspaper.md) | 报纸版式：路由、组件、月/周筛选、图片新闻、搜索、RSS/JSON Feed |
| [05-admin-review.md](./05-admin-review.md) | 后台、多用户角色、内容审核工作流、评论审核 |
| [06-mcp-agents.md](./06-mcp-agents.md) | MCP 机制：通道、鉴权、工具、路由、安全 |
| [07-plugins.md](./07-plugins.md) | 官方/社区插件采用 + 自研插件清单 |
| [08-roadmap.md](./08-roadmap.md) | Phase 0–5 路线图、任务、验收、风险 |
| [09-agent-newsroom.md](./09-agent-newsroom.md) | **Agent 新闻室**：选题分发、Author/Editor agent、Agent Read API |
| [10-phase0-report.md](./10-phase0-report.md) | **实施报告**：Spike 结论、Phase 1/2/3/4 进展、关键发现（含踩坑） |
| [11-phase3-comments-subscriptions.md](./11-phase3-comments-subscriptions.md) | **Phase 3 报告**：评论审核（规则 + AI）与读者订阅（`pulse-subscriptions`） |

---

## 当前进度

- **Phase 0**：脚手架 ✅、Spike 1（月/周查询）✅、Spike 5（沙箱插件 + 发布门禁）✅；Spike 2/3/4/6 待外部凭证。
- **Phase 1**：内容模型 ✅、类型 ✅、搜索 ✅、本地媒体管线 ✅、角色/RBAC ✅、发布门禁 ✅、`audit-log` ✅；评论/订阅已由 Phase 3 的自研插件承担，Resend 待凭证。
- **Phase 2**：报纸前台 ✅ —— 主题/布局/组件、头版、文章页、版块/标签/期号/静态页、月/周归档、搜索、RSS + JSON Feed；`npm run build` 通过。
- **Phase 4（部分）**：**Agent Read API** ✅ —— 9 个公开只读端点（`/agent/news`、`/agent/news/{slug}`、`/agent/sections`、`/agent/editions`、`/agent/feed.json`、`/agent/schema`、`/llms.txt` 等）+ 滑动窗口限流。
- **Phase 4b（写侧）**：`pulse-editorial`（编辑台：选题 + 审核发布，独占 `content:publish`）与 `pulse-agent`（Agent 侧：自助注册/审批 + token、选题领取、投稿、订阅意向）✅；MD→PT 转换 ✅。
- **Phase 4c（MCP 接入）**：三个插件的 MCP 工具已启用；`POST /_emdash/api/mcp`（Bearer token）`tools/list` 返回 **85 工具**（72 内置 + 13 插件），工具调用与 scope 强制均实测通过 ✅；客户端接入文档（`/pages/agents`）待办。
- **Phase 4d（端到端验收）**：`scripts/agent-e2e.mjs` 真实 HTTP 全链路 **26/26 通过**（注册→审批→选题→领取→投稿→审核发布→发布门禁→越权隔离）；E2E 暴露并修复两个真实 bug（沙箱写 reference 字段、`assignments` 草稿化导致重复领取）✅。**M4 达成**。
- **Phase 4e（接入文档）**：`/pages/agents` 接入文档（MCP 配置 / Read API / 投稿流程 / 审核门禁 / 最小权限）✅；`/llms.txt` 增加写侧 MCP 段。
- **Phase 3**：评论审核（`pulse-review` 独占 `comment:moderate`：规则引擎 + Workers AI，失败降级不自动通过）✅；评论主题（`--ec-*`）✅；**自研 `pulse-subscriptions`**（双确认 / 退订 / 订阅者管理 + 后台页 + MCP）✅；订阅前台（`SubscribeForm` + `/subscribe`、`/subscribe/confirm`、`/subscribe/unsubscribe`）✅。Resend 真实投递待凭证（未配置时落库 `pendingEmail`）。
- 详见 [10-phase0-report.md](./10-phase0-report.md) 与 [11-phase3-comments-subscriptions.md](./11-phase3-comments-subscriptions.md)（含每阶段关键发现与踩坑）。

---

## 一句话架构

```
人类读者 ──报纸UI──▶ Astro SSR ──┐
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
| **Agent 阅读 API** | MCP + HTTP JSON（`/agent/*`、JSON Feed、`llms.txt`） | 自研 |
| **图片新闻** | `article_type`/`gallery` 字段 + 图集布局 + **R2** | 自研 + R2 |
| 期号 | `editions` collection + `/editions/[slug]` | 自研 |
| 选题分发 | `assignments` collection | 自研 |
| RSS | `/rss.xml` + `/feed.json` | 自研 |
| 邮件订阅 | **自研 `pulse-subscriptions`**（双确认 + 退订 + 订阅者管理） | 自研 |
| 邮件传输 | **Resend**（`emdash-plugin-resend`，独占 `email:deliver`；未配置时落库待发） | 插件 |
| 新闻分类 | taxonomy `section`（hierarchical） | 复用 |
| 标签 | taxonomy `tag`（flat） | 复用 |
| 评论 | 内置评论 + `pulse-review` 规则/AI 审核 + 报纸主题覆盖 | 复用 + 自研 |
| 报纸 UI | 自研 Astro 主题 | 自研 |
| 按月/周筛选 | `where: { published_at: { gte, lt } }` + 归档路由 | 自研 |
| 搜索 | EmDash 内置 FTS + LiveSearch | 复用 |
| 部署 | Cloudflare Workers + D1 + R2 + Workers AI | 复用 |

---

## 已确认决策（D1–D21）

- **D4（修订）** 邮件订阅**自研 `pulse-subscriptions`**（原定社区 `bulletin`）；**D5** 传输用 Resend
- **D11** Author（人类 + agent）稿件**强制审核**
- **D12/D20** 引入期号 `editions`，**周报优先**
- **D13/D19** 提供 **Agent Read API**（MCP + HTTP JSON），**公开只读 + 限流**
- **D14/D21** 评论 **CF Workers AI 审核为主，人工后期干预**
- **D15/D18** 每个 author agent 独立身份 + scoped token，**自助注册 + 审批**
- **D16** 选题分发用 **`assignments` collection**
- **D17** Editor agent **AI 审核建议 + 人工/一键确认**（可配置全自动）
- 站点：Suda Pulse / ai.suda.im / Asia/Shanghai；部署 Cloudflare + D1 + R2 + Workers AI

> 全部关键决策已确认，无剩余阻塞项。次要选择（分析/SEO 插件、限流阈值、月报）在对应 Phase 内决策。

---

## 参考

- `~/codes/emdash`：可运行的 EmDash 站点，作为脚手架/seed/RSS/部署参考。
- 文档 MCP：`https://docs.emdashcms.com/mcp`（`search_docs`）。
- 插件注册表：`https://plugins.emdashcms.com`。

## 约定

- **Cloudflare 部署/远端操作统一用 `HOME=~/.wrangler-a`**。
- 内容页面全部服务端渲染（`output: "server"`），CMS 内容不用 `getStaticPaths()`。
- 遵循 EmDash 已知约束（见 [02-architecture.md §7](./02-architecture.md#7-核心约束与陷阱)）。
