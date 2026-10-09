# 11 · Phase 3 实施报告（评论与邮件订阅）

> 评论审核（规则 + AI）与读者邮件订阅的落地记录。对应路线图 [08-roadmap.md](./08-roadmap.md) 的 Phase 3。

## 状态总览

| 项 | 状态 | 说明 |
| --- | :-: | --- |
| 评论渲染 | ✅ | `/articles/[slug]` 已挂 `CommentForm` + `Comments`（`allow_comments !== false` 时） |
| 评论审核（规则） | ✅ | `pulse-review` 独占 `comment:moderate`：链接/黑名单/重复/引流/HTML |
| 评论审核（AI） | ✅ | Workers AI（Llama Guard）经 **REST** 调用；失败**降级不自动通过** |
| 评论主题 | ✅ | `--ec-*` 覆盖（表单/分隔线/提交按钮贴合报纸主题） |
| 读者订阅 | ✅ | 自研 `pulse-subscriptions`：双确认 / 退订 / 订阅者管理 |
| 订阅分组 | ✅ | 分组可管可勾；停用只影响前台表单，不解除已有订阅 |
| 订阅事件日志 | ✅ | append-only `events`，后台按订阅者回放时间线（退订记录） |
| 后台暂停 | ✅ | `paused` 状态：停投递、保留记录，**只能后台恢复** |
| 订阅前台 | ✅ | `SubscribeForm` + `/subscribe`、`/subscribe/confirm`、`/subscribe/unsubscribe`（订阅管理页） |
| 邮件投递 | ✅（本地） | dev 走内置 console provider；生产待 Resend 凭证 |
| 反垃圾 / 通知插件 | ⏸️ | `comment-spam-protection` / `comment-notify` 待注册表安装（见 `07-plugins.md` §5.1） |
| 摘要邮件 | ⏸️ | 待 Resend + 内容选择策略（`pulse-digest`，按需） |

### 决策修订

- **D4 修订**：订阅由社区 `bulletin` 改为**自研 `pulse-subscriptions`**。原因：需要与报刊内容模型/Agent 订阅意向对齐的**自有订阅表**，且本地可完整验证数据流；邮件发送抽象为「有 provider 就发，没有就落库待发」，不被单一传输插件绑定。
- **D14 落地方式**：评论审核**规则 + AI 同时实现**（用户确认）。规则引擎为确定性兜底，AI 为可选增强；本地无 CF binding 时走降级路径，行为可预测。

---

## 1. 评论审核（`pulse-review`）

### 1.1 关键机制：独占 hook 会**替换**内置审核器

`comment:moderate` 是**独占 hook**。插件一旦注册，宿主通过 `setExclusiveSelection` 自动选中唯一提供者，**内置审核器 `emdash-default-comment-moderator` 不再执行**。因此插件**必须复刻内置决策逻辑**，否则会静默改变站点行为：

| 内置规则 | 复刻实现（`moderation.ts` 的 `baselineDecision`） |
| --- | --- |
| `commentsModeration = "none"` | 直接 `approved` |
| 已登录用户 ∈ `commentsAutoApproveUsers` | `approved` |
| `moderation = "first_time"` 且 `priorApprovedCount > 0` | `approved` |
| 其余 | `pending` |

### 1.2 能力要求（易踩坑）

`HOOK_REQUIRED_CAPABILITY` 中 **`comment:moderate` 要求 `users:read`**（**不是** `comments:moderate`）——因为 hook 事件包含作者邮箱 / IP 哈希 / UA。能力不匹配时 hook 会被**静默跳过**（无报错，表现为「审核没生效」）。

### 1.3 决策顺序

```
规则判 spam ──▶ 直接 spam（不调 AI，省一次外呼）
  │ 否则
  ▼
AI（可选）── unsafe ──▶ spam
  │        └ 失败/超时 ──▶ 降级到规则结论（绝不自动通过）
  │        └ safe ──▶ aiAutoApprove ? approved : 基线
  ▼
基线（复刻内置）
```

规则项：`too_short`(spam) / `too_long`(pending) / `link_flood`(spam) / `banned_word`(spam) / `contact_spam`(pending) / `repeat_chars`(pending) / `raw_html`(spam) / `name_is_url`(spam)。

### 1.4 沙箱无 Workers AI binding → 走 REST

沙箱插件**拿不到** Workers AI binding，故 AI 审核经 REST：
`POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/<model>`，`ctx.http.fetch` + `allowedHosts: ["api.cloudflare.com"]`。
响应形如 `{ result: { response: "safe" | "unsafe\nS1,S6" } }`（`parseLlamaGuard`）。
超时用 `AbortController` + `setTimeout`（不用 `AbortSignal.timeout`，workerd 下更稳）。

### 1.5 后台设置（`admin.settingsSchema`）

`rulesEnabled` / `bannedWords`(multiline) / `maxLinks` / `maxLength` / `minLength` / `aiEnabled` / `aiAutoApprove` / `aiAccountId` / `aiApiToken`(**secret**) / `aiModel`(select) / `aiTimeoutMs`。

> `aiAutoApprove` 默认 **false**：AI 只作建议，结论仍为待审 —— 符合「AI 建议 + 人工确认」。

---

## 2. 读者订阅（`pulse-subscriptions`）

### 2.1 数据模型

插件存储三个集合：

- **`subscribers`**（唯一索引 `emailHash`；索引 `status` / `createdAt` / `tokenHash`）
- **`groups`**（订阅分组；索引 `active` / `sortOrder`；**slug 即记录 id，创建后不可变**）
- **`events`**（订阅事件日志，append-only；索引 `subscriberId` / `type` / `at`）

订阅状态机（`paused` 只能由后台进出，读者重新提交订阅**不会**自动恢复）：

```
pending ──confirm──▶ confirmed ──unsubscribe──▶ unsubscribed
   ▲                    │  ▲                          │
   └─ 重新提交（发新确认邮件）┘  │                        │
                        pause│  │resume（仅后台）          │
                             ▼  │                        │
                           paused ──unsubscribe──────────┘
```

- 邮箱以**规范化（trim + 小写）后的 SHA-256** 作唯一键（`emailHash`），明文仅用于投递。
- 确认 / 退订 token 形如 `ps_confirm_<random>` / `ps_unsub_<random>`，**只存 SHA-256 哈希**（`tokenHash`），明文仅出现在邮件链接中。
- **同一 token 贯穿确认与退订**：确认后用途翻转为 `unsubscribe`（不轮换），因此**重复点击确认/退订链接都幂等**（刷新、双击、邮件客户端预取都不会报错）。
- **分组**是叠加在订阅之上的细分段：记录用 `groups: string[]`（slug 列表）持有，空数组 = 主刊订阅者。停用分组只影响前台表单，不解除已有订阅关系。
- **事件日志**是旁路（`recordEvent` 吞异常，写失败不连累主流程）：`requested` / `confirmed` / `unsubscribed` / `paused` / `resumed` / `groups_changed` / `request_blocked`，各带 `actor`（reader/admin/system）与可选 `reason` / `detail`。
- 状态流转只有一份实现（`src/operations.ts`）：后台行级操作与私有路由 `subscribers/update` 共用。

### 2.2 路由

| 路由 | 方法 | 可见性 | 说明 |
| --- | --- | --- | --- |
| `subscribe/request` | POST | 公开（raw） | 建 pending + 发确认邮件；已确认则幂等返回（可顺手更新分组）；命中 `paused` 则不改状态、只记 `request_blocked`；按 IP 限流 5/小时 |
| `subscribe/confirm` | POST | 公开（raw） | 凭 token 转 confirmed，发欢迎邮件（含退订链接） |
| `unsubscribe` | POST | 公开（raw） | 凭 token 转 unsubscribed，可带 `reason` |
| `preferences` | POST | 公开（raw） | 读者自助（token 即凭证）：只读返回 `{email,status,groups,available}`；带 `groups` 则写入 |
| `groups/public` | POST | 公开（raw） | 只读启用中的分组（前台订阅表单用）。**刻意不限流**——SSR 取不到真实 IP |
| `subscribers/list` | POST | 私有 `plugins:manage` | 列表（`status` / `group` / `q` / `limit`）+ 各状态计数（MCP `listSubscribers`） |
| `subscribers/update` | POST | 私有 `plugins:manage` | 行级操作：`pause` / `resume` / `unsubscribe` / `set_groups` |
| `subscribers/events` | POST | 私有 `plugins:manage` | 某订阅者的事件时间线 |
| `groups/list` | POST | 私有 `plugins:manage` | 分组列表（含 `members` 计数；MCP `listGroups`） |
| `groups/save` | POST | 私有 `plugins:manage` | 新建（`create:true`，slug 必须不存在）/ 更新分组 |
| `groups/delete` | POST | 私有 `plugins:manage` | 删除分组，并先从订阅者记录里摘掉该 slug |
| `admin` | — | 私有 `plugins:manage` | 后台两页（Block Kit，靠 `input.page` 分派） |

### 2.2.1 后台两页（Block Kit）

manifest `admin.pages` 注册 `/subscribers`（订阅者）与 `/groups`（订阅分组），**共用同一个 `admin` 路由**——
宿主 `SandboxedPluginPage` 会给每个非 `page_load` 交互补上 `page` 字段，处理器据此分派。

三个必须记住的宿主行为（实现见 `src/admin.ts`）：

1. **宿主不回传上一次的表单值**：翻页 / 排序只回传 `block_action.value`。所以筛选条件
   （状态 / 分组 / 关键词 / 页码）整体编码进**分页按钮的 value**（`encodeState`），否则一翻页筛选就丢。
   这也是**不用** `table.next_cursor` 的原因——它会覆盖 value 且只带游标。
2. **`form_submit` 回传 `block_id`**：用来携带记录 id（`subscriber-groups:<id>`、`group-save:<slug>`），
   因为 values 里只有字段值。
3. **分组是数组字段，插件存储建不了索引** ⇒ 订阅者列表走内存扫描 + 内存分页，
   `MAX_SCAN = 1000` 护栏，触顶用 `banner` 显式提示收窄筛选（而不是静默少几行）。

行级操作用仓库既有约定 `"<action>:<id>"` 冒号编码（`table` + `columns[].format:"element"` + 行数据放 `menu`，见 pulse-agent）。
Block Kit 的**块与元素是两层**：`menu` / `select` / `checkbox` 等是元素，必须嵌在 `actions` / `form` / `table` 的 element 列里，直接放进 `blocks[]` 会被宿主判 `INVALID_BLOCK_RESPONSE`（后台整页 502）。

### 2.3 邮件抽象：没有 provider 也不报错

`deliver(ctx.email, message)`：

- `ctx.email` 存在 → 发送，`emailDelivered = true`；
- **不存在或抛错** → 返回 `{ delivered: false, reason }`，把邮件快照（to/subject/text/html）落库为记录的 **`pendingEmail`**，**请求仍成功**。

配套设置 **`autoConfirm`**（单确认）：无邮件服务时（本地 / 未接 Resend）也能让订阅进入 `confirmed` 并拿到退订 token，便于端到端验证。

### 2.4 前台接线（为什么提交走浏览器、确认走 SSR）

| 环节 | 方式 | 原因 |
| --- | --- | --- |
| 订阅提交 | **浏览器 `fetch`**（`SubscribeForm.astro`） | `subscribe/request` 按**客户端 IP** 限流；SSR 代理用的是合成 `Request`（无 `cf` 对象），`extractRequestMeta` 取不到真实 IP，所有人会挤进同一个限流桶 |
| 确认 / 退订 / 读改分组 | **SSR**（`getPublicPluginApiRouteHandler`，`src/utils/subscriptions.ts`） | token 即凭证，无需前端 JS；不受提交限流影响，邮件链接直接打开即出结果 |

页面：`/subscribe`（表单 + 分组勾选 + 流程说明）、`/subscribe/confirm`、
`/subscribe/unsubscribe`（**订阅管理页**：GET 只读、退订 / 改分组走原生 POST，`noindex`）；
入口：页脚「订阅」链接 + 头版订阅区块。

- 分组勾选**只在 `/subscribe` 页**渲染（`fetchActiveGroups` → `SubscribeForm` 的 `groups` prop）；
  一个都不勾 = 只收主刊。
- 管理页的状态机集中在 `resolveManageOutcome`（`missingToken` / `invalidToken` / `unsubscribed` / `paused` / `manage`），
  两套主题只负责渲染。**GET 一律只读**——退订必须显式 POST（避免邮件客户端预取链接就退订）。

### 2.5 评论主题

EmDash 评论组件用 `--ec-*` 变量控制外观（`emdash/src/components/Comments.astro`、`CommentForm.astro`）：

- 带 fallback 的变量（表单那组）在 `:root` 覆盖即可；
- 组件**内部已声明默认值**的变量（`--ec-comment-gap` / `--ec-comment-indent` / `--ec-comment-border`）因 Astro scoped 样式特异性更高，需用 `.ec-comments.ec-comments` 重复类名提升特异性才能覆盖；
- 新增 `--color-success` 令牌用于评论表单成功态。

---

## 3. 验证

### 3.1 单元 / 集成测试（`npm run plugin:test`）

| 插件 | 用例 | 覆盖 |
| --- | :-: | --- |
| `pulse-review` | 40 | 规则引擎 / Llama Guard 解析 / 决策顺序 / AI 失败降级 / 独占 hook 集成（含内置逻辑复刻） |
| `pulse-subscriptions` | 55 | token 与邮箱哈希 / 邮件构建与投递降级 / 双确认 / 幂等 / 限流 / 列表计数（`mail.test.ts` 16 + `plugin.test.ts` 22 + `admin.test.ts` 17）；分组 CRUD 与收敛、`preferences` 读写、后台暂停 / 恢复、事件时间线、按分组过滤、后台两页每个子视图过 `validateBlocks` |
| `pulse-agent` | 28 | 注册/审批/token/限流 + MD→PT + 投稿端到端 |
| `pulse-editorial` | 9 | 审核流转 + 选题 |

`pulse-subscriptions` 的集成测试分两层：

- `plugin.test.ts` 用 `createPluginRuntimeTestHost()` 起**真实沙箱宿主**：宿主注入 email provider，测试从 `inspect.email()` **读回确认邮件里的 token** 再走确认 / 退订 —— 即验证「邮件里链接可用」这一真实路径。**路由级测试不可省**：后台 Block Kit 路径不过 zod，能掩盖 schema 漏字段一类的 bug（见 §4 发现 10）。
- `admin.test.ts` **不起 workerd**：直接调 `admin` 路由处理器 + 内存版存储，再用宿主同款 `validateBlocks(blocks, {})` 复核每个页面 / 子视图 —— Block Kit 校验不过就是后台整页 502，所以这一步必须逐页跑。

### 3.2 HTTP 冒烟（`npm run dev`，5 个插件全部加载）

启动日志：
```
EmDash: Loaded sandboxed plugin pulse-review:0.2.0 with capabilities: [hooks.content-policy:register, network:request, users:read]
EmDash: Loaded sandboxed plugin pulse-subscriptions:0.1.0 with capabilities: [email:send]
```

| 调用 | 结果 |
| --- | --- |
| `POST /pulse-subscriptions/subscribe/request` | `200 {ok:true,status:"pending",delivered:true}` |
| 同邮箱重复提交（pending） | `200`（轮换 token 重发确认邮件） |
| 非法邮箱 | `400 INVALID_INPUT` |
| `GET /subscribe` | `200`（表单渲染） |
| `GET /subscribe/confirm?token=<确认邮件里的 token>` | `200`「订阅已确认」 |
| 同 token 再次确认 | `200`「该邮箱此前已完成订阅」（幂等） |
| `GET /subscribe/unsubscribe?token=<同一 token>` | `200`「已退订」 |
| `GET /subscribe/confirm?token=bogus` | `200`「确认失败」 |
| 头版 `/`、文章页 `/articles/<slug>` | `200`（评论组件 + 订阅区块正常） |

> 本地 dev 由 EmDash **内置 console email provider**（`emdash-console-email`，dev 下自动注册）承接投递，邮件正文打印到 dev 日志，确认 / 退订 token 可从中读取。

---

## 4. 新增关键发现

1. **`comment:moderate` 是独占 hook**：注册即替换内置审核器，**必须复刻内置逻辑**（自动通过规则），否则会静默改变站点行为。独占选择由宿主 `setExclusiveSelection` 自动完成，无需插件声明。
2. **`comment:moderate` 的能力是 `users:read`**（不是 `comments:moderate`）。能力不匹配时 hook **静默跳过**，排查时容易误判为「代码没跑」。
3. **沙箱插件无法访问 Workers AI binding**，只能经 REST 调 `api.cloudflare.com`（`network:request` + `allowedHosts`）。因此 AI 审核是**可选增强**，不是默认路径。
4. **AI 失败必须降级到规则结论，绝不自动通过**：否则一次超时就会放行垃圾评论。
5. **`ctx.email` 在未配置 provider 时是 `undefined`**（且仅在声明 `email:send` 后才存在）。把「发送」抽象成返回 `{delivered, reason}` 的纯函数，调用方落库 `pendingEmail`，可让**无邮件服务的本地环境完整验证订阅数据流**。
6. **订阅提交不能走 SSR**：插件公开路由按 IP 限流，而 SSR 里的合成 `Request` 没有 `cf` 对象，`extractRequestMeta` 的 IP 解析全部落空（→ 所有用户共用一个限流桶）。EmDash 为 SSR 页面提供了 `getPublicPluginApiRouteHandler`（`emdash/plugin-utils`），适合**确认 / 退订**这类 token 即凭证的端点。
7. **`getPublicPluginApiRouteHandler` 对 raw 路由返回 `PluginResponse` 信封**（`{__emdashPluginResponse, status, body:{kind:"text",value}}`），SSR 侧需自行解包（`src/utils/subscriptions.ts`）。
8. **Astro scoped 样式的特异性**：组件内部声明的 CSS 自定义属性（如 `--ec-comment-border`）带 `[data-astro-cid-*]`，外部 `:root` 覆盖不了；需提高选择器特异性（`.ec-comments.ec-comments`）或改用组件暴露的 fallback 变量。
9. **dev 自带 console email provider**：`import.meta.env.DEV` 下自动注册独占 `email:deliver`（`emdash-console-email`），邮件正文打印到 dev 日志 —— 本地验证订阅闭环的**关键便利**。
10. **`z.object` 默认剥掉未声明的键**：`groups/save` 的 `create` 开关一度漏在 schema 外，`create: true` 被**静默丢弃** → 新建退化成更新 → slug 不存在 → `INVALID_SLUG`（表现为「建不了分组」，一路连累 preferences / 分组过滤）。凡是要透传给内部分支的开关字段，必须在 zod schema 里显式声明（zod 不是 passthrough）。**注意**：走后台 Block Kit 的路径不过 zod（直接调 `saveGroup`），所以后台测试全绿也掩盖不了这个 bug —— 路由级测试不可省。
11. **宿主会给每个非 `page_load` 交互补 `page` 字段**（`SandboxedPluginPage` 里 `{...interaction, page}`）：后台多页共用同一个 `admin` 路由时靠它分派。**测试里必须模拟**，否则交互落到默认页，症状是「分组页点编辑却渲染出订阅者页」。
12. **宿主不回传上一次的表单值**：翻页 / 排序只回传 `block_action.value`，`table.next_cursor` 还会被宿主覆盖成 `{cursor,sort}`（丢筛选）。所以筛选状态必须整体编码进**分页按钮的 value**，不能依赖 `next_cursor`。
13. **数组字段建不了插件存储索引**：按分组筛选只能把记录读回来内存过滤（`scanSubscribers` + `MAX_SCAN` 护栏），并需要在 UI 上显式提示截断，而不是静默少几行。
14. **声明的 `uniqueIndexes` 是「整表」唯一索引，不是「按集合」唯一**：`subscribers` 声明 `uniqueIndexes: ["emailHash"]` 后，宿主建的是
    `_plugin_storage(plugin_id, collection, json_extract(data,'$.emailHash'))` 上的唯一索引 —— 它覆盖该表**所有行**。
    所以**同一个插件里另一个集合若也用同名字段，就会互撞**：`events` 一度照抄 `emailHash`，结果同一订阅者的第 2 条事件就撞唯一约束，
    `recordEvent` 吞掉异常 ⇒ **事件静默丢失**。更隐蔽的是：内存版测试宿主不校验索引，55 个用例全绿；只有真 SQLite（本地 seed / dev）才暴露。
    **规则**：跨集合复用的字段名要避开被声明为 unique 的字段；事件这类一对多记录只留 `subscriberId` 即可（订阅者 id 稳定，从不重建）。

    > **2026-10-09 在 PG + emdash 1.2.0 上复测更正**：上面「跨集合复用同名字段就会互撞」的**机制描述有误** —— 索引键是
    > `(plugin_id, collection, (data)::jsonb->>'field')`，**`collection` 在键里**，故跨集合同值**不会**互撞（实测：`subscribers` 与 `events`
    > 同存 `emailHash=H` 均写入成功；`subscribers` 内重复 `H` 才被拦）。当初真正踩的坑是**同一集合内该字段有合法重复值**
    > —— `events` 里同一订阅者会有多条事件（`emailHash` 相同）→ 同集合撞唯一约束。**规则照旧**：只给「本集合内必然唯一」的字段声明
    > `uniqueIndexes`；字段名跨集合复用无需回避。复测脚本见 `scripts/` 临时冒烟（已删）。
15. **`z.object` 之外的同类陷阱**：任何「只在真数据库 / 真宿主上才生效」的约束（唯一索引、触发器、字段规范化），都要在本地跑一遍 seed 或 dev 才算验证过 —— 单测与 typecheck 都覆盖不到。

---

## 5. 待办 / 待凭证

- **Resend**：配置 `emdash-plugin-resend`（或等价传输）后，`delivered` 才会在生产为 `true`；否则记录会停在 `pendingEmail`。
- **反垃圾 / 评论通知插件**：`comment-spam-protection`、`comment-notify` 待注册表安装（依赖 DoH 可达网络）。
- **摘要邮件**：待定 —— 自研 `pulse-digest`（`content:read` + `email:send` + `cron`）。
- **订阅者导出 / 清理**：目前仅列表 + 计数 + 分组；导出 CSV 与失效邮箱清理后置。
- **生产限流**：`ctx.kv` 计数是「按插件实例」近似，多 isolate 下非严格全局（Phase 5 换 Rate Limiting binding / Durable Object）。
