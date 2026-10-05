# Agent instructions

Before editing this plugin, read `~/codes/emdash/.agents/skills/creating-plugins/SKILL.md` (and its `references/`) completely.
Keep `emdash-plugin.jsonc` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the generated validation, test, and build scripts after changes.

## 本插件要点

- 订阅者存于插件存储 `subscribers`（唯一索引 `emailHash`），**不是** EmDash 用户。
- 状态机：`pending` → `confirmed` → `unsubscribed`；token（确认/退订）只存 SHA-256 哈希，明文仅在邮件链接里。
- 公开路由（`subscribe/request|confirm`、`unsubscribe`）为 `response: "raw"`，返回真实状态码（400/429），并自带限流。
- 邮件走 `ctx.email`（`email:send` + 已配置 provider）；**provider 缺失或投递失败时不抛错**，落库为 `pendingEmail`。无邮件服务时可开 `autoConfirm`（单确认）。
- 改 `capabilities` / `storage` 必须升 `package.json` 的 `version`（信任契约变更）。
- 改动后必须 `npm run plugin:build`（根目录），沙箱 entry 内嵌的是已构建的 `dist/*.mjs`。
