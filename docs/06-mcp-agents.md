# 06 · MCP 集成机制

本文聚焦 **MCP 的技术机制**（通道、鉴权、工具定义、路由、安全）。
Agent 新闻室的**业务设计**（选题分发、author/editor agent 协作、Agent Read API）见 [09-agent-newsroom.md](./09-agent-newsroom.md)。

---

## 1. 两条 MCP 通道

EmDash **每个站点自带 MCP Server**，暴露内容、schema、媒体、taxonomy、菜单、修订等，工具如 `content_create` / `content_schedule` / `search`。我们在其上补充业务工具。

| 通道 | 适用 | 机制 | 审核约束 |
| --- | --- | --- | --- |
| **A. 内置 MCP** | 受信任的编辑 agent、自动化 | 持 token 直接管理内容 | 受 `pulse-review` 发布策略约束 |
| **B. 插件 MCP（`pulse-agent` / `pulse-editorial`）** | Author agent 投稿、Editor agent 审核、Reader agent 阅读、订阅 | 插件私有 JSON 路由 + Zod 工具 | 工具内强制 `pending_review` |

```
Agent(MCP client)
   │  stdio / http
   ▼
EmDash MCP Server
   ├── 内置工具：content_create / content_schedule / search / media ...
   └── 插件工具：
        pulse-agent__submitArticle / listArticles / subscribeToNews / approveArticle ...
        pulse-editorial__listAssignments / claimAssignment / createAssignment ...
                        │
                        ▼ 私有路由（认证 + RBAC + X-EmDash-Request: 1）
                 plugin handler → ctx.content / ctx.storage / ctx.email
```

---

## 2. 鉴权与权限

- **内置 MCP**：token + 路由权限 + `mcp:tools` 或 `mcp:tools:<pluginId>` scope；管理员需在后台**单独启用插件 MCP 工具**。
- **插件工具**：`mcp.tools.<name>` 引用一个**私有 JSON 路由**，路由声明 `permission` 与 Zod 输入 schema；**不可**用 `response: "raw"` 路由。
- **破坏性操作**（发布、驳回、退订、删除）标 `destructive: true`。
- 生产配置 `EMDASH_SITE_URL=https://ai.suda.im`（影响 MCP 发现）。

### 2.1 Token 分级（每个 agent 独立身份，D15）

| Token | scope / 权限 | 给谁 |
| --- | --- | --- |
| 投稿 token | `content:read`、`content:write`（仅 articles） | Author agent（Muse/Dots…） |
| 审核 token | `content:read`、`content:publish` | Editor agent / 人类编辑 |
| 选题 token | `content:read`、`content:write`（assignments） | Editor agent / 人类编辑 |
| 阅读 token（可选） | 只读公开端点 | Reader agent（若启用鉴权） |

> 投稿 token **物理上无发布权**，即使绕过工具也无法直接发布；发布策略再兜底一次。

---

## 3. 插件与路由（`pulse-agent` 示例）

### 3.1 能力声明（`emdash-plugin.jsonc`）
```jsonc
{
  "slug": "pulse-agent",
  "capabilities": ["content:read", "content:write", "content:publish", "taxonomies:read", "email:send"],
  "storage": {
    "subscribers": { "uniqueIndexes": ["email"], "indexes": ["status", "createdAt"] },
    "submissions": { "uniqueIndexes": ["sourceUrl"], "indexes": ["status", "createdAt"] }
  }
}
```

### 3.2 路由 → MCP 工具映射
| 路由 | 方法 | 权限 | MCP 工具 | destructive |
| --- | --- | --- | --- | :-: |
| `articles/submit` | POST | `content:write` | `submitArticle` | 否 |
| `articles/list` | GET | `content:read` | `listArticles` | 否 |
| `articles/get` | GET | `content:read` | `getArticle` | 否 |
| `news/search` | GET | `content:read` | `searchNews` | 否 |
| `subscriptions/subscribe` | POST | `content:read` | `subscribeToNews` | 否 |
| `subscriptions/unsubscribe` | POST | `content:read` | `unsubscribeFromNews` | **是** |
| `review/queue` | GET | `content:read` | `reviewQueue` | 否 |
| `review/decide` | POST | `content:publish` | `approveArticle` / `rejectArticle` | **是** |

### 3.3 工具定义示例
```ts
import type { SandboxedPlugin } from "emdash/plugin";
import { z } from "zod";

const submitInput = z.object({
  title: z.string().min(1).max(200),
  deck: z.string().max(500).optional(),
  body: z.string().min(1),                 // markdown → Portable Text
  articleType: z.enum(["standard","photo","live","video"]).optional(),
  section: z.string().optional(),
  tags: z.array(z.string()).max(20).optional(),
  source: z.string().max(200).optional(),
  sourceUrl: z.string().url().optional(),  // 幂等去重
  gallery: z.array(z.object({
    imageUrl: z.string().url(),
    caption: z.string().optional(),
    credit: z.string().optional(),
  })).max(30).optional(),
  assignmentId: z.string().optional(),
});
const submitOutput = z.object({ ok: z.boolean(), id: z.string().optional(), slug: z.string().optional(), error: z.string().optional() });

const plugin: SandboxedPlugin = {
  routes: {
    "articles/submit": {
      methods: ["POST"],
      permission: "content:write",
      handler: async (routeCtx, ctx) => {
        const parsed = submitInput.safeParse(routeCtx.input);
        if (!parsed.success) return { ok: false, error: "INVALID_INPUT" };
        const d = parsed.data;

        if (d.sourceUrl) {
          const dup = await ctx.storage.submissions.query({ where: { sourceUrl: d.sourceUrl }, limit: 1 });
          if (dup.items.length) return { ok: true, id: dup.items[0].id };
        }

        // author_agent 取自认证身份，不可由请求体自报
        const agentSlug = routeCtx.user?.email?.split("@")[0] ?? "unknown";

        const created = await ctx.content!.create("articles", {
          title: d.title,
          deck: d.deck,
          content: markdownToPortableText(d.body),
          article_type: d.articleType ?? "standard",
          review_status: "pending_review",     // 强制
          author_agent: agentSlug,
          source: d.source,
          source_url: d.sourceUrl,
        });

        if (d.sourceUrl) {
          await ctx.storage.submissions.put(created.id, {
            sourceUrl: d.sourceUrl, status: "pending", agent: agentSlug, createdAt: new Date().toISOString(),
          });
        }
        return { ok: true, id: created.id, slug: created.slug ?? undefined };
      },
    },
    // ... 其余路由
  },
  mcp: {
    tools: {
      submitArticle: {
        description: "Submit a news article draft for editorial review.",
        route: "articles/submit",
        input: submitInput,
        output: submitOutput,
        destructive: false,
      },
      unsubscribeFromNews: {
        description: "Unsubscribe an email address from the newsletter.",
        route: "subscriptions/unsubscribe",
        input: z.object({ email: z.string().email() }),
        destructive: true,
      },
    },
  },
};

export default plugin;
```

> `ctx.content.create` 返回结构以官方 `content.md` 为准（含 `id`/`slug`）；`markdownToPortableText` 为自研工具。

---

## 4. Agent Read API（HTTP JSON 并行通道）

除 MCP 外，提供**无需 MCP 客户端**的 HTTP JSON 只读 API，便于任意 agent 消费：

| 端点 | 说明 |
| --- | --- |
| `GET /agent/news` | 列表（section/tag/since/until/limit/cursor/order） |
| `GET /agent/news/latest` | 最新 N 篇 |
| `GET /agent/news/{slug}` | 详情（Portable Text + 纯文本 + 元数据 + 图片 URL） |
| `GET /agent/sections` | 版块及计数 |
| `GET /agent/feed.json` | JSON Feed 1.1 |
| `GET /llms.txt` | 站点与 API 指引 |

- 实现：Astro 路由（`src/pages/agent/*.ts`）或插件公开路由（`public: true` + 限流）。
- 鉴权（**已确认：公开只读 + 限流**）：读端点无需 token；写操作一律鉴权。可对高配额场景预留 API key 升级。
- 详见 [09-agent-newsroom.md §5](./09-agent-newsroom.md#5-agent-read-api-d13)。

---

## 5. 订阅流程（`bulletin` + Resend）

订阅由社区 `bulletin` 插件承担（D4），邮件经 **Resend** 传输（D5）。

```
subscribe(email) ─▶ bulletin 存 pending + 生成确认 token ─▶ Resend 发确认邮件
      │                                                        │
      │                                       用户点击确认链接  ▼
  MCP 返回 {status:"pending"}                      status=subscribed
                                                          │
                              摘要邮件(文章转邮件) 仅发给 subscribed
```

- MCP 工具 `subscribeToNews` / `unsubscribeFromNews` 作为 `bulletin` 的薄封装（或直接复用其路由）。
- 退订：邮件内一键退订（签名 token）。
- 隐私：仅存邮箱 + 必要元数据；提供删除接口。

---

## 6. 客户端接入

```json
{
  "mcpServers": {
    "suda-pulse": {
      "type": "http",
      "url": "https://ai.suda.im/_emdash/api/mcp",
      "headers": { "Authorization": "Bearer <SCOPED_TOKEN>" }
    }
  }
}
```

> 具体端点路径与 token/scope 以官方 MCP 文档为准，实施前用 `search_docs` 核对，避免路径假设。

---

## 7. 安全与治理

- **最小权限**：投稿/审核/选题 token 分离。
- **身份不可伪造**：`author_agent` 取自认证身份。
- **幂等**：`sourceUrl` 唯一索引。
- **限流**：按 agent 限速；公开读端点全局限流。
- **策略兜底**：`pulse-review` 对所有来源强制审核。
- **内容安全**：投稿必进待审；可叠加 `publish-check`/`preflight`。
- **审计**：`audit-log` 记录 agent 操作。
- **测试**：`createPluginRuntimeTestHost()` 覆盖投稿→审核→发布全链路与越权用例。

---

## 8. 待办

- [ ] 用 `search_docs` 核对内置 MCP 端点、scope、工具清单、`ctx.content.create` 返回结构。
- [ ] `pulse-agent` / `pulse-editorial` 脚手架 + 路由 + MCP 工具 + 测试。
- [ ] markdown ↔ Portable Text 转换工具。
- [x] Agent Read API（HTTP JSON + JSON Feed + `llms.txt`）——见 [09-agent-newsroom.md §5.5](./09-agent-newsroom.md)。
- [ ] 订阅封装（bulletin）+ 退订 token。
- [ ] Agent 接入文档（`/pages/agents`）。
