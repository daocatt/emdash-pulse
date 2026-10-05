# 05 · 后台管理、多用户与内容审核

后台**直接使用 EmDash 内置 Admin**（`/_emdash/admin`），不重写。本文聚焦：角色映射、审核工作流、评论审核、通知与审计。

---

## 1. 多用户与角色

EmDash 内置 5 角色：**Subscriber / Contributor / Author / Editor / Admin**，权限随角色递增，且**内容归属（ownership）**影响操作范围。

**角色等级（数值，存于 `users.role`）**：`10 Subscriber` · `20 Contributor` · `30 Author` · `40 Editor` · `50 Admin`
（来源：`@emdash-cms/admin` 的 `ROLE_NAMES`；`VALID_ROLE_LEVELS = {10,20,30,40,50}`。下表自上而下即 10→50。）

| 角色 | 阅读 | 写稿 | 提交待审 | 审核/通过 | 发布他人稿 | 管理分类/菜单 | 评论审核 | 用户/插件/设置 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Subscriber | ✅ | | | | | | | |
| Contributor | ✅ | ✅ | ✅ | | | | | |
| Author | ✅ | ✅ | ✅ | | | | | |
| Editor | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | |
| Admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 编辑室映射建议
- **外部投稿者 / Agent** → Contributor：只能创建草稿并提交待审。
- **本报记者** → Author：写稿并提交待审（**已确认：Author 强制审核**）。
- **Author agent**（Muse/Dots…）→ Contributor 权限 + 独立 token：只能提交待审（见 [09-agent-newsroom.md](./09-agent-newsroom.md)）。
- **编辑 / Editor agent** → Editor：审核队列、发布、管理版块/标签/评论、创建选题。
- **管理员** → Admin：用户、插件、设置、内容模型、备份、agent 注册。

### 登录
- EmDash 使用 **Passkey / WebAuthn**（FIDO2）作为原生认证，无弱密码。
- 本地开发无生物识别设备时使用官方 dev-bypass（**仅本地，生产务必关闭**）。
- 生产环境务必配置 `EMDASH_SITE_URL`，否则 Passkey/CSRF 在反代下失效。

### 用户管理能力（内置）
- 邀请/禁用用户、分配角色、重置 Passkey。
- 编辑锁（edit locking）：开启后同一文章被锁定，防止覆盖；过期保存会被拒绝。

### Phase 1 已落地（本地验证）
- **管理员**：本地用官方 dev-bypass 创建（`/_emdash/api/setup/dev-bypass`，`Dev Admin`，role 50）。生产用 Passkey 完成 setup。
- **角色邀请**：经 `POST /_emdash/api/auth/invite`（Admin only）创建，落库于 `auth_tokens`（`type=invite`，含 `email`/`role`/`hash`）。已建：`editor@suda.im`(40)、`reporter@suda.im`(30)、`contributor@suda.im`(20)、`muse@suda.im`(20)、`dots@suda.im`(20)。
  - 邀请的**完成**依赖 WebAuthn（Passkey）注册，需在浏览器打开邀请链接；无邮箱 provider 时接口返回"已发送"但不实际发信（Phase 3 接 Resend 后自动发信）。
- **RBAC 边界验证**（临时改 `users.role` 实测，验后已还原为 50）：

  | 操作 | Contributor(20) | Admin(50) |
  | --- | :-: | :-: |
  | 创建草稿 `POST /content/articles` | ✅ 201 | ✅ 201 |
  | 发布 `POST /content/articles/{id}/publish` | ❌ 403 `FORBIDDEN` | ✅ 200 |
  | 定时发布 `POST /content/articles/{id}/schedule` | ❌ 403 `FORBIDDEN` | — |

- **两道独立闸门**：① RBAC（角色需 `content:publish`，Editor/Admin）→ 403；② `pulse-review` 策略（`review_status==="approved"`）→ 422 `PUBLISH_REJECTED`。二者互不替代。

---

## 2. 内容审核工作流

### 2.1 状态与字段
- EmDash 原生：`status`（draft / published）+ 草稿修订 + 定时发布 + 预览链接。
- 自研编审字段：`review_status`（draft / pending_review / approved / rejected）+ `review_note`（见 [03-content-model.md](./03-content-model.md#2-articles-字段定义)）。

### 2.2 强制规则
> **核心约束：只有 `review_status === "approved"` 的稿件才允许发布。**

通过 `pulse-review` 插件注册发布策略 hook 强制：

```ts
// plugins/pulse-review/src/plugin.ts
import type { SandboxedPlugin } from "emdash/plugin";

const plugin: SandboxedPlugin = {
  hooks: {
    "content:beforePublish": async (event) => {
      if (event.collection !== "articles") return;
      const data = event.content.data as Record<string, unknown>;
      if (data.review_status !== "approved") {
        return { cancel: true, reason: "稿件需经编辑审核通过后方可发布。" };
      }
    },
    "content:beforeSchedule": async (event) => {
      if (event.collection !== "articles") return;
      const data = event.content.data as Record<string, unknown>;
      if (data.review_status !== "approved") {
        return { cancel: true, reason: "定时发布前需先审核通过。" };
      }
    },
  },
};

export default plugin;
```

- 能力：`hooks.content-policy:register`（独立于读/写/发布权限）。
- 策略对**所有来源**生效：Admin UI、REST、**MCP**、视觉编辑、插件、定时任务。定时发布到期时会**再次**执行策略。

### 2.3 状态流转（编辑视角）
```
草稿(draft) ──投稿者/Agent提交──▶ 待审(pending_review)
待审 ──编辑通过(设 approved)──▶ 已通过(approved) ──发布──▶ 已发布(published)
待审 ──编辑驳回(设 rejected + review_note)──▶ 已驳回(rejected) ──退回修改──▶ 草稿
```

### 2.4 审核队列（后台）
- 方案 A（MVP）：用 EmDash Admin 的**集合列表 + 筛选**（按 `review_status` 排序/过滤）作为待审队列。
- 方案 B（增强）：`pulse-review` 提供 **Block Kit 后台页面/仪表盘 widget** 展示"待审数量 + 快捷通过/驳回"，通过私有路由操作。
- 方案 C（MCP）：暴露 `review_queue` / `approve_article` / `reject_article` MCP 工具，供编辑的 agent 使用（见 [06-mcp-agents.md](./06-mcp-agents.md)）。

### 2.5 通知
- 新投稿 → 通知编辑（邮件 / webhook）。
- 审核结果 → 通知投稿者。
- 实现：`content:afterSave` 中判断 `review_status === "pending_review"` 触发通知；或用 `@emdash-cms/plugin-webhook-notifier`。

---

## 3. 评论审核

### 3.1 内置能力
- 集合 `commentsEnabled: true`（articles 已开启）。
- 评论状态：`approved` / `pending` / `spam`。
- 后台 **Comments** 区域审核；支持线程（threaded）。
- 前端组件：`Comments` + `CommentForm`（`emdash/ui/comments`），`contentId` 用 `article.data.id`。

### 3.2 默认策略（建议）
- **先审后发**：首评默认 `pending`，编辑通过后显示。
- 老用户（已有通过评论）可自动通过：`comment:moderate` 独占钩子按 `priorApprovedCount` 决策。
- 在 `pulse-review` 中实现 `comment:moderate`（**需 `users:read`**，不是 `comments:moderate`）。

### 3.3 反垃圾与 AI 审核（已确认）
| 插件 | 作用 | 采用 |
| --- | --- | --- |
| **`pulse-review`（自研）** | 规则引擎（链接/黑名单/引流/重复/HTML）+ Workers AI（Llama Guard） | ✅ **已实现** |
| `@emdash-cms/plugin-ai-moderation` | 官方 AI 审核（TS 源码打包问题暂缓，见 `07-plugins.md` §5.1） | ⏸️ |
| `@peachfinthemes.com/comment-spam-protection` | 本地规则（敏感词/链接/语言/重复/限速） | ✅ 建议（与自研规则互补） |
| `@lasymphonieagency.com/comment-notify` | 新评论邮件通知管理员 | ✅ 建议 |

> 策略：**规则 + AI 给出建议 → 人工/规则决策**。首评默认 `pending`，编辑通过后显示。

**实现要点（Phase 3，详见 [11-phase3-comments-subscriptions.md](./11-phase3-comments-subscriptions.md)）**：

- `comment:moderate` 是**独占 hook**，注册即**替换**内置审核器 → 必须复刻内置逻辑（`moderation=none` / `commentsAutoApproveUsers` + 已登录 / `first_time` + `priorApprovedCount>0`）。
- 沙箱插件**拿不到 Workers AI binding**，AI 经 REST 调 `api.cloudflare.com`（`network:request` + `allowedHosts`）。
- 规则判 spam 直接返回，不调 AI；AI 失败/超时**降级到规则结论，绝不自动通过**。
- 设置项见后台插件设置（`rulesEnabled` / `bannedWords` / `maxLinks` / `aiEnabled` / `aiAutoApprove` / `aiApiToken` 等）。

### 3.4 前端评论渲染
```astro
---
import { Comments, CommentForm } from "emdash/ui/comments";
---
{article.data.allow_comments !== false && (
  <>
    <Comments collection="articles" contentId={article.data.id} threaded />
    <CommentForm collection="articles" contentId={article.data.id} />
  </>
)}
```

---

## 4. 审计与历史

| 能力 | 实现 |
| --- | --- |
| 内容修订历史 | EmDash 内置 revisions（`supports: ["revisions"]`） |
| 操作审计日志 | `@emdash-cms/plugin-audit-log`（create/update/delete 记录） |
| 编辑活动历史 | `@masonjames.com/simple-history`（可选） |

---

## 5. 后台配置清单（Phase 1 完成项）

- [x] 创建管理员账号（本地 dev-bypass；生产 Passkey 待部署时完成）。
- [x] 导入 seed：articles / pages / editions / assignments / taxonomies / menus / widgets / bylines。
- [x] 配置站点设置：标题、标语、时区（`Asia/Shanghai`）。
- [x] 邀请编辑、记者、投稿者账号并分配角色（invite 已建；Passkey 注册待浏览器完成）。
- [ ] **注册 author agent**（Muse/Dots…）：user + byline + scoped token（Phase 4）。
- [x] 开启 articles 的 search 索引（FTS 已建，5 articles + 4 pages 已索引）。
- [x] 评论审核：`pulse-review` 独占 `comment:moderate`（规则引擎 + AI 分支），评论主题已覆盖。
- [ ] 评论反垃圾 / 通知插件（注册表安装，待 DoH 可达网络）；AI 审核的 `aiAccountId` / `aiApiToken` 待 CF 凭证。
- [ ] 订阅邮件传输：配置 `emdash-plugin-resend`（待 Resend 凭证；未配置时订阅邮件落库为 `pendingEmail`）。
- [x] 配置 `pulse-review` 发布策略（沙箱加载，门禁生效）。
- [x] 验证：未审核稿件无法发布（REST 路径已验；MCP/定时路径 Phase 4 复验）。

---

## 6. 安全要点

- 生产关闭 dev-bypass 端点。
- 所有插件路由默认私有，需认证 + 权限 + `X-EmDash-Request: 1`。
- 公开路由（如投稿/订阅）需 API key / 签名校验 + 速率限制 + 输入校验。
- 备份 `EMDASH_ENCRYPTION_KEY`；丢失将无法解密插件密钥。
- 定期用 `npx emdash site export` 备份站点（含内容与评论者邮箱，视同数据库备份）。
