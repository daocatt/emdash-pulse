# 10 · Phase 0 实施报告

> 脚手架与验证阶段的记录。随实施推进更新。

## 状态总览

| # | 任务 | 状态 |
| --- | --- | --- |
| 0.1 | 脚手架（astro/worker/live.config/wrangler/seed/AGENTS） | ✅ 完成 |
| 0.2 | 站点标识（Suda Pulse / ai.suda.im / Asia/Shanghai） | ✅ 完成 |
| 0.3 | 依赖安装 + dev 启动 + admin 可达 | ✅ 完成 |
| 0.4 | seed 内容导入（articles/pages/taxonomies/bylines/menu） | ✅ 完成 |
| **Spike 1** | 按月/周范围查询（`where.published_at` gte/lt） | ✅ **通过** |
| **Spike 5** | 沙箱插件注册（`pulse-review`）+ 发布门禁策略 | ✅ **通过** |
| Spike 2 | `bulletin` 订阅 + Resend 发信 | ⏳ 待凭证（Resend API Key） |
| Spike 3 | Resend 传输插件 | ⏳ 待凭证 |
| Spike 4 | Cloudflare Workers AI 评论审核 | ⏳ 待 CF 账号/绑定 |
| Spike 6 | R2 媒体上传/读取 | ⏳ 待 CF 账号（本地用 local storage） |

## Spike 1 结果（已通过）

用 `/spike/date-range.json` 验证 `where: { published_at: { gte, lt } }`（半开区间）：

| 查询 | 区间 | 命中 |
| --- | --- | --- |
| 2026-08 | 2026-08-01T00:00Z .. 2026-09-01T00:00Z | review-workflow |
| 2026-09 | 2026-09-01 .. 2026-10-01 | suda-pulse-launch |
| 2026-10 | 2026-10-01 .. 2026-11-01 | image-news-on-r2, agent-newsroom-design |
| 2026-W34 | 2026-08-17 .. 2026-08-24 | review-workflow |
| 2026-W41 | 2026-10-05 .. 2026-10-12 | agent-newsroom-design |
| 2026-W42 | 2026-10-12 .. 2026-10-19 | image-news-on-r2 |

结论：**月/周归档筛选可行**，`src/utils/date-range.ts` 的区间计算正确，可直接用于 Phase 2 的 `/archive` 路由。

## Spike 5 结果（已通过）

**目标**：验证沙箱插件在真实站点中注册、加载，且 `content:beforePublish` 策略钩子能对所有发布通路生效。

**接线方式**（`astro.config.mjs`）：
```js
import pulseReview from "pulse-review";
emdashConfig = {
  // ...
  sandboxed: [pulseReview],
  sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox", // Node 本地
  // Cloudflare 分支：sandboxRunner: sandbox()（来自 @emdash-cms/cloudflare）
};
```
插件以本地依赖链接进项目：`"pulse-review": "file:./plugins/pulse-review"`。

**证据**：

1. 启动日志确认隔离加载：
   ```
   EmDash: Loaded sandboxed plugin pulse-review:0.1.0 with capabilities: [hooks.content-policy:register]
   ```
2. 端到端门禁（REST API，dev-bypass 登录）：
   - 创建 `review_status: pending_review` 草稿 → `POST /publish` 返回 **422 `PUBLISH_REJECTED`**，message 为策略中的中文原因。
   - `PUT` 改为 `review_status: approved` → 再次 `POST /publish` 返回 **200**，`status` 变为 `published`。

结论：**发布门禁由沙箱策略统一把关**，对 REST 通路生效；MCP / 视觉编辑 / 定时发布共用同一 `publish()` 通路，理论上同样受控（Phase 4 再逐条复验）。`pulse-review` 可继续扩展评论审核策略。

## 关键发现（非显而易见，实施时必读）

1. **自动 seed 只建 schema，不含内容**。首次请求的 auto-seed 调用 `applySeed(..., { onConflict: "skip" })`，未传 `includeContent`，因此**内容/术语/署名不会自动导入**。需显式运行：
   ```bash
   npx emdash seed seed/seed.json            # 含内容
   npx emdash seed seed/seed.json --validate # 仅校验
   npx emdash seed seed/seed.json --no-content
   ```
   > 因此 CI/部署脚本需在首次部署后执行一次 `emdash seed`。

2. **seed 内容的分类关联键是 `taxonomies`**（不是 `terms`）。`SeedContentEntry.taxonomies: Record<string, string[]>`。用 `terms` 会被忽略。

3. **select 字段选项键是 `options`**（`field.options`）。

4. **`published_at` 以 ISO 8601 UTC 字符串存储**（如 `2026-10-05T14:57:53.387Z`），字符串比较即时间比较 —— 这正是范围查询可行的基础。

5. **直接用 sqlite3 CLI 改 `ec_articles` 会被 FTS 触发器拦截**（`unsafe use of virtual table "_emdash_fts_articles"`）。需先 `PRAGMA trusted_schema=ON;`。仅用于本地调试，勿在生产如此操作。

6. **Node 版本警告**：部分 EmDash 包要求 `^22.22.2 || ^24.15.0 || >=26.0.0`，本机 `v24.11.1` 触发 `EBADENGINE` 警告（非致命，运行正常）。建议后续升级 Node 到 `24.15+`。

7. **沙箱插件脚手架需要 publisher DID**（非 handle，避免网络解析）。本地站点依赖可先用占位 DID：`did:plc:zp6y7q3n5k2m4x8w9v1t6r0s`。

8. **npm 冷启动 + 网络不稳**：首次安装可能 `ECONNRESET`；用 `npm install --prefer-offline --no-audit --no-fund` 重试即可。

9. **`@emdash-cms/plugin-test@0.1.0` 内置旧版 plugin-cli（0.11.0）**，不识别 `hooks.content-policy:register` 等新能力，导致 `npm run test` 报 `MANIFEST_INVALID`（而 `npm run validate` 用的是顶层 0.13.2，能通过）。**须将 plugin-test 升级到 `^0.2.7`**，并把插件 devDependency 的 `emdash` 对齐到 `^1.1.0`。

10. **沙箱插件能力名**（`emdash@1.1.0` 运行时支持，经 `grep` 确认）：`hooks.content-policy:register` 用于发布策略钩子（`content:beforePublish` / `beforeSchedule` / `beforeUnpublish`），**不需要** `content:read/write/publish`。

11. **沙箱插件在 Node 本地需 `@emdash-cms/sandbox-workerd`**（依赖 `workerd` + `miniflare`），配置为 `sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox"`。Cloudflare 端用 `sandbox()`（来自 `@emdash-cms/cloudflare`，返回 runner 模块路径；Worker Loader 不可用时返回 `undefined`，此时沙箱插件在构建期被禁用）。

12. **沙箱插件 descriptor 的 `entrypoint` 必须能通过 `require.resolve` 解析到「已构建的 JS」**。`generateSandboxedPluginsModule` 用 `createRequire(project/package.json).resolve(entrypoint)` 定位文件，并直接读取源码文本内嵌进沙箱。因此：
    - 插件 package.json 的 `exports` 必须提供 **`default` 条件**（CJS 解析只用 `require`/`default`），仅有 `import` 会导致 `ERR_PACKAGE_PATH_NOT_EXPORTED`；
    - 必须**先 `npm run build`** 生成 `dist/*.mjs`，指向 TS 源码会报 "resolves to unbuilt source"；
    - 沙箱 entry 的 bundle 需**无外部 import**（当前 `dist/plugin.mjs` 已内联全部逻辑）。
    - 本地开发用 `file:` 依赖把插件链接进 `node_modules`，`entrypoint: "pulse-review/sandbox"` 才能解析。

13. **REST API 测试要点**：写请求需 `X-EmDash-Request: 1` 头（CSRF），否则 403 `CSRF_REJECTED`；内容更新用 **`PUT`**（非 PATCH）；登录可用 `/_emdash/api/setup/dev-bypass`。另：编辑 `astro.config.mjs` 会触发 dev server 重启，若在重启窗口内发请求会报 `Vite module runner has been closed`（500），**等重启完成再请求**即可。

## 环境

- Node v24.11.1（建议 24.15+），npm 11.7.0
- Astro 7.3.5 · EmDash 1.1.0
- 本地：SQLite `data.db` + `./uploads`；后台 `/_emdash/admin`（首次重定向 `/setup`）

## 待凭证/账号事项

- **Resend**：需要 API Key 才能验证发信（Spike 2/3）。
- **Cloudflare**：需要账号 + `HOME=~/.wrangler-a` 登录，创建 D1/R2 并启用 Workers AI（Spike 4/6）。
- 邮件订阅插件 `bulletin` 的安装与配置同样依赖上述。
