# Agent instructions

Before editing this plugin, read `.agents/skills/creating-plugins/SKILL.md` (and its `references/`) completely.
Keep `emdash-plugin.jsonc` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the generated validation, test, and build scripts after changes.

## 本插件要点

- 只注册 `page:metadata` 钩子（无能力要求），贡献 head 元数据。
- 以 `id: "primary"` 覆盖 EmDash 默认 JSON-LD；不要改成别的 id，否则会与默认块并存。
- 注册为**可信插件**（`plugins: []`，in-process），不放进 `sandboxed: []`。
- 数据只来自 `PublicPageContext`，不要在钩子里做查询（每页渲染都会执行）。
- 改动后必须 `npm run plugin:build`（根目录）。
