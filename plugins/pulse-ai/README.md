# pulse-ai

Suda Pulse 的 **AI 接入层**：把「用哪个模型、怎么调」收敛到一个可配置的插件，
方便后续接入更多模型（Cloudflare Workers AI / OpenAI / Anthropic，均可经
**Cloudflare AI Gateway** 统一入口）。

## 它做什么

1. **配置页**（`admin.settingsSchema` 自动生成）：provider、Cloudflare Account ID、
   AI Gateway 名称、自定义端点、模型、API Key（AES-GCM 加密存储）、超时、最大输出。
2. **后台「AI 网关」页**：展示解析出的端点与关键配置，并有「测试连接」按钮发一次
   真实补全 —— 不必翻容器日志就能确认网关通不通。
3. **可复用客户端** `pulse-ai/client`（零依赖 ESM）：`loadAiSettings()` /
   `readAiSettings()` / `buildAiRequest()` / `parseAiResponse()` / `parseGuardVerdict()` /
   `aiComplete()` / `isConfigured()`。

## 为什么是「库」而不是「跨插件 hook」

EmDash 的 hook 名是**封闭枚举**，插件之间没有自定义事件总线；插件设置 / KV 也按
plugin id 隔离（`ctx.settings` 只能读自己的，`getPluginSettings()` 只在宿主侧可用）。
本项目所有插件都在宿主进程内运行，因此**同进程直接引用**是唯一干净的复用方式：
消费方（目前是 `pulse-review` 的评论审核）引用 `pulse-ai/client`，并用
`loadAiSettings()` 读取本插件的配置。

## 用法（消费方）

```ts
import { aiComplete, loadAiSettings } from "pulse-ai/client";

const settings = await loadAiSettings(); // 读 pulse-ai 的插件设置（含加密 apiKey）
const result = await aiComplete(
  (url, init) => ctx.http.fetch(url, init), // 走本插件的 allowedHosts 门禁
  { messages: [{ role: "user", content: "…" }] },
  settings,
);
if (result.ok) {
  // result.text 是归一化后的模型输出
}
```

## 端点选择

| 场景 | URL |
| --- | --- |
| Workers AI 直连 | `https://api.cloudflare.com/client/v4/accounts/<acc>/ai/run/<model>` |
| 经 AI Gateway（任意 provider） | `https://gateway.ai.cloudflare.com/v1/<acc>/<gateway>/<provider>/…` |
| OpenAI 直连 | `https://api.openai.com/v1/chat/completions` |
| Anthropic 直连 | `https://api.anthropic.com/v1/messages` |
| 自定义端点 | `<baseUrl>/chat/completions`（OpenAI 兼容）/ `<baseUrl>/v1/messages`（Anthropic） |

优先级：**自定义端点 > AI Gateway > provider 官方域名**。填了 Gateway 名称就走网关
（可开日志 / 缓存 / 限流 / 回退），留空则直连 provider。

## ⚠️ 两条打包约束（改动前必读）

`emdash-plugin build` 用 rolldown 打包 `src/plugin.ts` 及其静态依赖。实测结论：

1. **除 `emdash/plugin` 与 `zod` 外，任何裸模块名都会被判为 external**，产物被拷到
   临时目录做 probe 时解析不到 → 整包构建失败
   （`Cannot find package 'pulse-ai'`）。所以 `src/client.mjs` **必须零静态依赖**，
   对 `emdash` 的引用只能是**动态** `import(...)`。
2. **消费方不要把 `pulse-ai` 写进自己的 `dependencies`**。rolldown 按「声明过的依赖」
   做 external 判定：一旦声明，`pulse-ai/client` 会变成 external import → 构建失败；
   不声明时它会被**内联**进消费方产物（实测 pulse-review 的 `plugin.mjs` 5.9KB → 8.7KB）。

`loadAiSettings()` 里的动态 import 用**模板字符串**拼接（`` import(`${"emdash"}`) ``），
让 rolldown 无法静态分析 → 原样保留到运行期，由 Node 从插件目录向上解析到**宿主同一份**
`emdash` 实例（因此 `getDb()` 的 AsyncLocalStorage 请求上下文有效）。

## 开发

```bash
npm run build -w pulse-ai
npm run test  -w pulse-ai
npm run typecheck -w pulse-ai
```
