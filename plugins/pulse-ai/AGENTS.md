# Agent instructions

Before editing this plugin, read `skills/creating-plugins/SKILL.md` completely. Codex discovers the same directory through `.agents/skills`; Claude discovers it through `.claude/skills` and reads these instructions through `.claude/CLAUDE.md`.
Keep `emdash-plugin.jsonc` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the generated validation, typecheck, test, and build scripts after changes.

## 本插件特有的约束

- **`src/client.mjs` 必须零静态依赖**：`emdash-plugin build` 只内联 `emdash/plugin` 与
  `zod`，其余裸模块名一律判为 external，产物 probe 阶段会因解析不到而**整包构建失败**。
  需要读宿主能力时只能动态 `import(...)`，且要用模板字符串拼接让 rolldown 不做静态分析。
- **消费方不要把 `pulse-ai` 写进 `dependencies`**：声明了就会变成 external import →
  消费方构建失败。不声明时 `pulse-ai/client` 会被内联（见 README 的打包约束一节）。
- **改了 `src/client.mjs` 的导出，必须同步 `src/client.d.mts`**：运行期文件是手写 ESM，
  类型是手写声明，没有生成步骤。
- 端点 / provider 的改动同步更新 `README.md` 的端点表与 `emdash-plugin.jsonc` 的
  `provider` 选项。
