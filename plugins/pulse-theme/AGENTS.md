# Agent instructions

Before editing this plugin, read `~/codes/emdash/.agents/skills/creating-plugins/SKILL.md` (and its `references/`) completely.
Keep `emdash-plugin.jsonc` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the generated validation, test, and build scripts after changes.

## 本插件要点

- 只做一件事：后台「前台主题」页把主题写进**插件设置**（`ctx.settings`，落 options 表
  `plugin:pulse-theme:settings:<key>`）。**不写内容、不发邮件、不访问网络**，所以能力与存储都为空。
- 主题值的**消费方是宿主信任代码** `src/middleware.ts`（`getPluginSetting("pulse-theme","theme")`），
  不是本插件。改设置键名要同时改中间件。
- `src/plugin.ts` 的 `THEMES` 必须与 `astro.config.mjs` 的 `THEME_NAMES` 同名 —— 后者注入
  `/_t/<theme>/…` 路由前缀，名称不一致会 rewrite 到不存在的路由（404）。
- `admin` 路由是 Block Kit 页；交互回传 `{ type: "block_action", action_id, value }`。
- 改动后必须 `npm run plugin:build`（根目录），沙箱 entry 内嵌的是已构建的 `dist/*.mjs`。
