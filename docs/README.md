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
| [10-phase0-report.md](./10-phase0-report.md) | **实施报告**：Spike 结论、Phase 1 进展、关键发现（含踩坑） |

---

## 当前进度

- **Phase 0**：脚手架 ✅、Spike 1（月/周查询）✅、Spike 5（沙箱插件 + 发布门禁）✅；Spike 2/3/4/6 待外部凭证。
- **Phase 1**：内容模型 ✅、类型 ✅、搜索 ✅、本地媒体管线 ✅、角色/RBAC ✅、发布门禁 ✅、`audit-log` ✅；评论类插件与 `bulletin`/Resend 待凭证。
- 详见 [10-phase0-report.md](./10-phase0-report.md)。

---

## 一句话架构

```
人类读者 ──报纸UI──▶ Astro SSR ─┐
Author agent ──MCP/HTTP──▶ pulse-agent ──▶ EmDash Core ──▶ D1(内容) + R2(媒体) + Workers AI
Editor agent ──MCP/HTTP──▶ pulse-review ─┘
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
| 邮件订阅 | 社区 **`bulletin`** + **Resend** 传输 | 插件 |
| 新闻分类 | taxonomy `section`（hierarchical） | 复用 |
| 标签 | taxonomy `tag`（flat） | 复用 |
| 评论 | 内置评论 + **CF Workers AI** 审核 + 反垃圾 | 复用 + 插件 |
| 报纸 UI | 自研 Astro 主题 | 自研 |
| 按月/周筛选 | `where: { published_at: { gte, lt } }` + 归档路由 | 自研 |
| 搜索 | EmDash 内置 FTS + LiveSearch | 复用 |
| 部署 | Cloudflare Workers + D1 + R2 + Workers AI | 复用 |

---

## 已确认决策（D1–D21）

- **D4** 邮件订阅用社区插件 `bulletin`；**D5** 传输用 Resend
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
