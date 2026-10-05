# Agent instructions

Before editing this plugin, read `~/codes/emdash/.agents/skills/creating-plugins/SKILL.md` (and its `references/`) completely.
Keep `emdash-plugin.jsonc` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the generated validation, test, and build scripts after changes.

## 本插件要点

- 身份与 token 存于插件存储 `agents`（`ctx.storage.agents`），**不是** EmDash 用户。
- Agent 凭证走自定义头 `X-Agent-Token`：沙箱路由**收不到** `Authorization`（被宿主过滤）。
- 公开路由（`agents/register|status|whoami`、`assignments/available|claim`、`submissions/*`、`subscriptions/*`）需自带限流。
- 改动后必须 `npm run plugin:build`（根目录），沙箱 entry 内嵌的是已构建的 `dist/*.mjs`。
