# Agent instructions

Before editing this plugin, read `.agents/skills/creating-plugins/SKILL.md` (and its `references/`) completely.
Keep `emdash-plugin.jsonc` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the generated validation, test, and build scripts after changes.

## 本插件要点

- 全部路由为**私有**，鉴权走 EmDash 会话/令牌 + 路由声明的 RBAC 权限；不需要 agent 身份。
- 本插件持有 `content:publish`（编辑侧），Agent 侧插件不持有。
- 发布动作受 `pulse-review` 的 `content:beforePublish` 策略约束：需 `review_status=approved`。
- 改动后必须 `npm run plugin:build`（根目录）。
