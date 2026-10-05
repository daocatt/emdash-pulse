# pulse-seo

Suda Pulse **结构化数据** 插件（可信 / in-process）。

## 作用

EmDash 的 `<EmDashHead>` 会为公开页面自动输出一个 JSON-LD（文章页 `BlogPosting`，其余 `WebSite`）。本插件通过 `page:metadata` 钩子以 `id: "primary"` 贡献**唯一**的实体，覆盖默认块：

- 文章页 → `NewsArticle`
- 其余页 → `WebSite`

贡献按 `id` **首个胜出**去重，插件排在 base 之前，因此模板不再需要手工注入 JSON-LD。

## 特点

- capabilities：**无**（`page:metadata` 无能力要求）
- storage：无
- 数据仅取自 `PublicPageContext`，**零额外查询**
- 注册为**可信插件**（`plugins: []`），在宿主进程内执行，不给每个页面渲染增加 isolate 开销

## 命令

```bash
npm run build   # 构建 dist/*
npm run test    # validate + vitest
```
