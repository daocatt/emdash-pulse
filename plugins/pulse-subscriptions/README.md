# pulse-subscriptions

Suda Pulse **读者订阅**沙箱插件（自研，替代 bulletin 依赖）。

## 能力与存储

- capabilities：`email:send`
- storage：`subscribers`（唯一索引 `emailHash`；索引 `status` / `createdAt` / `tokenHash`）

状态机：`pending`（待确认）→ `confirmed`（已确认）→ `unsubscribed`（已退订）。
确认 / 退订 token 明文只出现在邮件链接中，存储只留 SHA-256 哈希。

## 路由

| 路由 | 方法 | 可见性 | 权限 | 说明 |
| --- | --- | --- | --- | --- |
| `subscribe/request` | POST | 公开 | — | 提交邮箱 → 建 pending + 发确认邮件（一次性 token）；已确认则幂等返回 |
| `subscribe/confirm` | POST | 公开 | — | 凭确认 token 转 confirmed，轮换出退订 token 并发欢迎邮件 |
| `unsubscribe` | POST | 公开 | — | 凭退订 token 转 unsubscribed |
| `subscribers/list` | POST | 私有 | `plugins:manage` | 订阅者列表 + 各状态计数 |
| `admin` | — | 私有 | `plugins:manage` | 后台「订阅者」页（Block Kit） |

公开路由为 `response: "raw"`（返回真实 400/429 状态码），并按 IP 限流。

MCP 工具：`listSubscribers`。

## 设置

`admin.settingsSchema`：`autoConfirm`（单确认，无邮件服务时可用）、`replyTo`、
`confirmSubject`、`welcomeSubject`、`confirmPath`、`unsubscribePath`。

## 邮件

走 `ctx.email`（需 `email:send` 能力 + 站点已配置 provider）。**未配置 provider 或投递失败时不报错**，
而是把邮件快照落库为 `pendingEmail`（`subscribers/list` 的 `pending_email` 字段可见）。

## 命令

```bash
npm run build   # 构建 dist/*
npm run test    # validate + vitest
```
