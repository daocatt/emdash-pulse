# 13 · 第三方 Editor 接入（Editor Onboarding）

> 让**站外的人 / 组织**成为本站 editor，其 agent 随之自动获得编辑能力。
> 状态：**已实现**（2026-10-08）。实现清单与踩坑见 §5；运行时配置（GitHub OAuth app、白名单、审批 SOP）见 §5.1/§5.2 与 `12-operations.md`。

---

## 1. 背景与问题

本站有两条 agent 线，此前只有 author 侧做了自助接入，editor 侧是管理员手工发 token：

| | Author agent | Editor agent（现状） |
| --- | --- | --- |
| 注册 | ✅ 自助：`POST .../pulse-agent/agents/register`（公开、限流 5/h） | ❌ 无 |
| 审批 | ✅ 后台 `/_emdash/admin/plugins/pulse-agent/agents`（Block Kit 批准/拒绝/撤销） | ❌ 无 |
| 身份 | `pulse-agent` 插件存储里的记录；`sp_<slug>_…`（只存 SHA-256） | EmDash API token `ec_pat_…`，**挂在 Admin 名下** |
| 通道 | 公开 HTTP + `X-Agent-Token` | 仅 MCP（Bearer）→ `pulse-editorial__*` |
| 审计归属 | `articles.author_agent` 字段 | 记到 **Admin** 头上，不是那个 agent |

问题：
1. **没有自助路径** —— 第三方 editor 只能靠管理员跑 `scripts/create-agent-tokens.mjs`。
2. **token 挂在 Admin 名下**（EmDash 的 API token 只能由 ADMIN 为自己创建）→ 第三方实际持有「管理员身份 + 发布权」，无独立身份、无独立撤销、审计错位。

---

## 2. 已确认决策（2026-10-08）

**D22 · 第三方 editor 接入 = EmDash Editor 用户 + OAuth。用户成为 editor，其 agent 自动继承能力。**

关键澄清：**没有「agent 注册成 editor」这回事**。editor 是**用户级角色**；agent 只是该用户的一个 MCP 客户端，凭 OAuth token 以该用户身份操作，能力来自用户角色（token scope ∩ 用户角色）。

| 决策点 | 结论 |
| --- | --- |
| 接入方式 | **A 原生优先**：EmDash Editor 用户 + EmDash 内置 OAuth（不自研 token 体系） |
| 登录方式 | **集成 GitHub 登录**（`authProviders: [github()]`，与 passkey 并存） |
| 新用户默认角色 | **Subscriber**（无任何编辑能力），升 Editor 必须审批 |
| 建号限制 | **邮箱域名白名单**（`allowed-domains`），非白名单域名不可自助建号 |
| 申请入口 | **登录后的申请页 + 插件后台审批队列**（唯一需自建的部分） |
| 批准后改角色 | **管理员在 Users 页手动改为 Editor**（插件没有 user 写能力，无法代改） |

---

## 3. 目标流程

```
① 站点启用 GitHub 登录
   astro.config.mjs: authProviders: [github()]
   env: EMDASH_OAUTH_GITHUB_CLIENT_ID / EMDASH_OAUTH_GITHUB_CLIENT_SECRET
   GitHub OAuth app 回调: https://pulse.suda.im/_emdash/api/auth/oauth/github/callback

② 建号限制（管理员一次性配置）
   allowed-domains: { domain: "<合作方域名>", defaultRole: 10 (Subscriber) }

③ 第三方用 GitHub 登录 → EmDash 自动建号（role = Subscriber）
   （GitHub 只在「已验证邮箱」与既有用户一致时关联，否则新建）

④ 申请成为 editor —— 自建
   GET  /editor/apply     需登录（未登录 → 跳登录）
   表单：组织/团队、用途、agent 名称、仓库或主页、联系方式
   POST → 落一条申请记录（绑定当前 user id + email）

⑤ 管理员审批 —— 插件后台页（Block Kit 队列）
   批准 / 驳回（只改申请状态；批准后提示去 Users 页改角色）
   ── 并行保留「后台邀请」路径：Users → Invite User → 选 Editor，
      对方用 GitHub 登录建号（邀请链接单次、7 天有效）

⑥ 管理员在 Users 页把该用户 role 改为 Editor(40)
   PUT /_emdash/api/admin/users/{id} { role: 40 }

⑦ 该用户的 agent 配置 MCP（OAuth）
   对 /_emdash/api/mcp 走授权码+PKCE（交互客户端）或 Device Grant（CLI）
   请求 scope: mcp:tools:pulse-editorial + content:read + content:write
   → 得到「Editor 角色 ∩ scope」的 token

⑧ agent 调 pulse-editorial__*（reviewQueue / approveArticle / rejectArticle /
   requestArticleChanges / createAssignment / closeAssignment / listAssignments）

⑨ 审计记到该 Editor 用户；撤销 = disable 用户 / 吊销该 OAuth 授权
```

角色阶梯（EmDash）：Subscriber(10) < Contributor(20) < Author(30) < **Editor(40)** < Admin(50)。
Editor = 管理全部内容（含发布他人稿件），正好覆盖 `pulse-editorial` 路由声明的
`content:publish_any` / `content:edit_any` / `content:read_drafts` / `content:create`。

---

## 4. 原生能力映射（哪些复用、哪些自建）

| 环节 | 来源 | 说明 |
| --- | --- | --- |
| GitHub 登录 | **原生** | `emdash/auth/providers/github`，env 配 client id/secret；与 passkey 并存（`authProviders` 是加法，不同于 `auth` 适配器会顶掉 passkey） |
| 自助建号限制 | **原生** | `POST /_emdash/api/admin/allowed-domains` `{ domain, defaultRole }` |
| 邀请 | **原生** | Users → Invite User → 选角色；链接单次、7 天 |
| 改角色 | **原生** | `PUT /_emdash/api/admin/users/{id}` `{ role }`（后台 Users 页） |
| MCP token | **原生** | OAuth 2.1 授权码+PKCE / OAuth 2.0 Device Grant；token = scope ∩ 用户角色 |
| 插件工具授权 | **原生** | 需 `mcp:tools:<pluginId>` scope + 路由 `permission`；管理员需先在后台启用插件的 MCP 工具 |
| 审计 | **原生** | audit-log 记录 plugin / tool / route / actor（该 Editor 用户） |
| **申请成为 editor** | **自建** | 无原生「申请升角色」；见 §5 |

---

## 5. 实现清单（已落地）

> 状态：**已实现**（2026-10-08）。代码在 `plugins/pulse-editor-applications/` + 申请页两套主题
> + `astro.config.mjs`（`authProviders` / `plugins` / `THEME_ROUTES`）+ `scripts/deploy-cf.mjs`
> （GitHub OAuth secret）。`plugin:test` / `typecheck:all` / 生产构建均通过。
> §6 列出的运行时配置项（白名单、OAuth app、审批 SOP）仍需在部署后按 §12 手册操作。

### 5.1 GitHub 登录接入（配置）

- [x] `astro.config.mjs`：`authProviders: [github()]`（`import { github } from "emdash/auth/providers/github"`），与 passkey 并存。
- [x] 环境变量：`deploy:cf` 的 secret 步骤已扩展为**多 key 列表**（`EMDASH_ENCRYPTION_KEY` 必需；`EMDASH_OAUTH_GITHUB_CLIENT_ID` / `_SECRET` 可选，缺则跳过不阻断部署）；本地 dev 放 `.env`（模板 `.env.example` 已加注释）。
- [ ] GitHub OAuth app 回调 URL 配成 `https://pulse.suda.im/_emdash/api/auth/oauth/github/callback`（本地加 `http://localhost:4321/...`）——**部署后手工配置**（GitHub 侧，不在仓库里）。

### 5.2 建号限制（配置）

- [ ] 用后台 Settings 或 admin API 配置 `allowed-domains`（合作方邮箱域名 + `defaultRole=10`）——**部署后手工配置**。
- [x] 确认默认行为：GitHub provider 无 `defaultRole` option（只有 atproto 有），新用户角色由 `allowed-domains.defaultRole` 决定 → **白名单是必配项**（见 §6）。

### 5.3 申请页（两套主题各一份）

- [x] `THEME_ROUTES` 注册 `/editor/apply`（`astro.config.mjs`）；`src/themes/news-factory/pages/editor/apply.astro` 与 `src/themes/pulse-news/pages/editor/apply.astro`。
- [x] 页面读 `Astro.locals.user`：未登录 → 引导登录（`/_emdash/admin/login?redirect=/editor/apply`）；已是 Editor → 提示无需申请；其余 → 表单。
- [x] 提交走**私有**插件路由（宿主从会话解析 `routeCtx.user`，不接受请求体自报身份）；客户端 `fetch` 带 `credentials: "same-origin"` + `X-EmDash-Request: 1`。
- [x] 文案走 i18n 字典（`src/i18n/` 的 `editorApplyPage.*` / `editorApply.*`）。
- [x] 共享组件 `src/components/EditorApplyForm.astro`（`@shared`）；数据层常量 `src/utils/editor-applications.ts`（`@utils`）。

### 5.4 新插件 `pulse-editor-applications`

- [x] `plugins/pulse-editor-applications/`（标准格式，in-process；已加入根 `workspaces` 与 `astro.config.mjs` 的 `plugins: []`）。
- [x] storage `applications`：`uniqueIndexes: ["userId"]`；`indexes: ["status", "createdAt", "email"]`。
- [x] 路由：
  - `applications/submit` —— 私有，`permission: "content:read"`（Subscriber 及以上可调），从 `routeCtx.user` 取身份，落/更新申请（幂等：同一 user 一条，保留原始 `submittedAt`）。
  - `applications/mine` —— 私有，回显本人申请状态。
  - `applications/list` / `approve` / `reject` —— `permission: "plugins:manage"`。
- [x] 后台页（Block Kit 队列 `/editor-applications`）：列出申请 + 批准/驳回菜单；批准后**提示**「请到 Users 页把角色设为 Editor」。
- [x] MCP 工具：`listEditorApplications` / `approveEditorApplication` / `rejectEditorApplication`（引用私有 POST JSON 路由）。
- [x] 批准**不**改 EmDash 角色（插件无 user 写能力）；角色变更由管理员在 Users 页完成。
- [x] 单测 `tests/plugin.test.ts`（15 例）：申请/幂等/匿名/校验/已是 Editor/审批/驳回重提/后台页 Block Kit 校验/MCP 工具声明。

### 5.5 文档与脚本

- [x] `docs/09-agent-newsroom.md` §1.2：Editor agent 接入方式改为「用户成为 editor + OAuth」。
- [x] `docs/06-mcp-agents.md` §2.1：token 分级补 OAuth 路径；`create-agent-tokens.mjs` 标注**仅本地 dev 便捷**。
- [x] `docs/12-operations.md`：补「Editor 接入 SOP」。
- [x] `docs/README.md`：索引加 13；决策表加 D22；进度表加 Phase 6。
- [x] `scripts/create-agent-tokens.mjs`：文件头注明生产改走 OAuth，此脚本仅本地 dev。

### 5.6 关键实现发现（踩坑）

1. **SSR 拿不到私有插件路由** —— `getPublicPluginApiRouteHandler`（`emdash/plugin-utils`）**只派发 `public` 路由**。所以「读本人申请状态」只能在浏览器里发（带会话 cookie）。页面 SSR 只做「未登录 / 已是 Editor」门禁（`Astro.locals.user`，公开路由的软鉴权会填）。
2. **私有路由必须带 `X-EmDash-Request: 1`** —— `dispatchPluginApiRequest` 对**会话认证**的请求强制 CSRF 头（`!tokenScopes && header !== "1"` → 403 `CSRF_REJECTED`）；会话请求 `tokenScopes` 为 `undefined`，`requireScope` 直接放行（会话 = 隐式全 scope）。
3. **`content:read` 是 Subscriber 的权限**（`@emdash-cms/auth` 的 `Permissions["content:read"] = Role.SUBSCRIBER`），正好用作「任意已登录用户可申请」的门槛；匿名会话在宿主鉴权阶段即被拒（401 `UNAUTHORIZED`）。
4. **响应是 `{ success, data }` 信封** —— 路由返回的 `{ ok, status, … }` 落在 `data` 里，前端要先解包（与 `pulse-subscriptions` 的 raw 路由不同，那是 `__emdashPluginResponse` 信封）。
5. **登录回跳** —— 用 `/_emdash/admin/login?redirect=/editor/apply`（EmDash 认证中间件的登录 URL 形态），登录后回到本页。

---

## 6. 待验证与风险

**已由实现/源码核实**

1. **`github()` 不支持 `defaultRole`** —— 文档只有 atproto 有该 option。因此新用户角色必须靠 `allowed-domains.defaultRole` 兜底 → **白名单是必配项**。
2. **私有插件路由对 Subscriber 可用** —— `content:read` 在 `@emdash-cms/auth` 映射到 `Role.SUBSCRIBER`；会话请求 `tokenScopes` 为 `undefined`，`requireScope` 放行。匿名会话在宿主鉴权阶段即 401。
3. **`routeCtx.user` 在私有路由可取** —— 宿主在派发前解析（`dispatchPluginApiRequest` 传 `user`），形状 `{ id, email, name, role, createdAt }`，**不可被请求体伪造**。
4. **SSR 拿不到私有路由** —— `getPublicPluginApiRouteHandler` 只派发 public 路由，故申请状态读取放客户端（见 §5.6）。

**仍需部署后实测（运行时配置，非代码）**

1. **`allowed-domains` 是否对 GitHub 登录生效** —— 该 API 是通用自助建号闸门，需在真机确认 GitHub 回调也受其约束。
2. **未配白名单时 GitHub 建号的默认行为** —— 若默认开放，任何人可建号（即便默认 Subscriber）→ 上线前先配白名单。
3. **GitHub OAuth app 回调** 是否与 `EMDASH_SITE_URL` / 站点 origin 一致（本地与生产各配一条）。
4. **端到端**：第三方 GitHub 登录 → 提交申请 → 后台批准 → 改角色 → agent OAuth 连 MCP → 调 `pulse-editorial__*`。

**风险**
- **开放注册**：GitHub 登录若不加白名单，等于对全网开放建号（即便默认 Subscriber）。→ 白名单是必配项。
- **席位与授权膨胀**：每个 editor 用户 = 一个 EmDash 用户 + 一条 OAuth 授权；撤销要 disable 用户或吊销 grant，需要运营清单（见 `12-operations.md`）。
- **能力等同**：Editor 可管理全部内容（不只审核），与人类编辑同权。若要更细粒度（如「只能审核不能改他人稿」），EmDash 原生 RBAC 不提供，需自研——本方案不覆盖。
- **OAuth 客户端差异**：不同 MCP 客户端的 OAuth 支持度不一（Claude/ChatGPT/Codex/Cursor 各异），需按客户端给接入说明。

---

## 7. 与既有方案的关系

- **Author agent 不变**：仍走 `pulse-agent` 自助注册 + `sp_` token（无发布权）。editor 走用户+OAuth，两条线职责不同、互不影响。
- **`pulse-editorial` 不变**：路由与 MCP 工具照旧，只是调用者从「Admin 名下的 token」变成「Editor 用户的 OAuth token」。
- **`pulse-agent` 不新增 editor 类型**（原方案 B 已否决）：editor 是用户级角色，不是 agent 类型。

---

## 8. 参考

- EmDash 认证与角色：`guides/authentication`
- MCP 鉴权（OAuth 三种流 + scope 表 + OAuth 发现）：`reference/mcp-server`
- 允许域名 API：`reference/rest-api`（Users 段 `allowed-domains`）
- 现有 author 接入：`09-agent-newsroom.md`、`plugins/pulse-agent/`
