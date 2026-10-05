# 04 · 前台报纸版式（Newspaper UI）

自研 Astro 主题，仅复用参考项目的工程结构（`Base.astro`、RSS、站点标识工具），**视觉与布局从零设计**。

---

## 1. 设计语言

| 维度 | 方案 |
| --- | --- |
| 基调 | 报纸：黑 / 白 / 米白，**单一强调色**（建议深红 `#b3261e` 或藏蓝 `#1a3a6b`） |
| 标题字体 | 衬线体（Source Serif 4 / Playfair Display / Noto Serif SC）—— `--font-heading` |
| 正文字体 | 无衬线（Inter / Noto Sans SC）—— `--font-body` |
| 数字/代码 | JetBrains Mono —— `--font-mono` |
| 版式 | 报头 + 多栏网格；细分隔线；栏间距；引题/主题/副题层级 |
| 交互 | 悬停标题下划线；图片 hover 微缩放；返回顶部；响应式折叠为单栏 |
| 深浅色 | `light-dark()` 令牌 + cookie/localStorage 首屏无闪烁 |

> 遵守参考项目 AGENTS.md 的告诫：**不引入第二个强调色、不使用彩色区块背景**。令牌集中在 `src/styles/tokens.css`，覆盖写在 `src/styles/theme.css`。

### 关键设计令牌（规划）
```
--font-heading / --font-body / --font-mono
--color-brand / --color-on-brand / --color-brand-ring
--color-bg / --color-surface / --color-text / --color-text-secondary / --color-muted / --color-border
--content-width (正文列 ~680px) / --wide-width (1200px)
--gutter-width (文章页侧栏) / --meta-col-width (左署名列)
```

---

## 2. 路由表

| 路由 | 文件 | 说明 |
| --- | --- | --- |
| `/` | `index.astro` | 头版：报头 + 头条 + 次头条 + 版块区块 + 侧栏 |
| `/articles/[slug]` | `articles/[slug].astro` | 文章详情（署名/日期/正文/图注/标签/评论/更正） |
| `/sections/[slug]` | `sections/[slug].astro` | 版块归档（taxonomy `section`） |
| `/tags/[slug]` | `tags/[slug].astro` | 标签归档（taxonomy `tag`） |
| `/archive` | `archive/index.astro` | 归档首页：按月/周导航 + 全部时间线 |
| `/archive/[year]/[month]` | `archive/[year]/[month].astro` | **按月**归档 |
| `/archive/[year]/week/[week]` | `archive/[year]/week/[week].astro` | **按周**归档（ISO 周） |
| `/editions/[slug]` | `editions/[slug].astro` | **期号**版面（月/周报） |
| `/search` | `search.astro` | 全文搜索 |
| `/subscribe` | `subscribe.astro` | 邮件订阅（双确认） |
| `/pages/[slug]` | `pages/[slug].astro` | 静态页 |
| `/rss.xml` | `rss.xml.ts` | 全站 RSS |
| `/feed.json` | `feed.json.ts` | JSON Feed 1.1 |
| `/sections/[slug]/rss.xml` | `sections/[slug]/rss.xml.ts` | 分版块 RSS（可选） |
| `/404` | `404.astro` | 404 |

> Agent 阅读通道见 [09-agent-newsroom.md](./09-agent-newsroom.md#5-agent-read-api-d13)（`/agent/news` 等 JSON 端点）。

---

## 3. 按月 / 按周筛选（核心）

已确认 EmDash `getEmDashCollection` 的 `where` 支持 `WhereRange`：`{ gt, gte, lt, lte }`（**string** 值）。日期字段以 ISO 字符串比较。

### 工具函数 `src/utils/date-range.ts`

```ts
// 返回 [start, end) 半开区间，便于 gte/lt
export function monthRange(year: number, month: number, tz = "Asia/Shanghai") {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { gte: start.toISOString(), lt: end.toISOString() };
}

// ISO 周：week = 1..53
export function weekRange(year: number, week: number, tz = "Asia/Shanghai") {
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = simple.getUTCDay() || 7;             // 周一=1..周日=7
  const monday = new Date(simple);
  monday.setUTCDate(simple.getUTCDate() - dow + 1);
  const nextMonday = new Date(monday);
  nextMonday.setUTCDate(monday.getUTCDate() + 7);
  return { gte: monday.toISOString(), lt: nextMonday.toISOString() };
}
```

> 时区：以站点设置 `timezone` 为准；如对边界要求严格，可用 `Intl.DateTimeFormat` 做时区换算。MVP 先用 UTC 边界，Phase 5 精修。

### 查询示例（按月）

```astro
---
import { getEmDashCollection } from "emdash";
const { year, month } = Astro.params;
const range = monthRange(Number(year), Number(month));
const { entries, cacheHint } = await getEmDashCollection("articles", {
  where: { published_at: range },
  orderBy: { published_at: "desc" },
  limit: 20,
});
if (Astro.cache?.enabled) Astro.cache.set(cacheHint);
---
```

### 分页
- 归档页用 **offset 分页**：`limit` + `offset = (page-1)*limit`（与 `cursor` 互斥，二选一）。
- 首页/列表用 **cursor 分页**（`nextCursor`）。

### 归档导航
- `/archive` 顶部提供「按月 / 按周」切换。
- 侧栏 `core:archives` widget（monthly）展示月份链接。
- 周视图生成当前年份的周列表（1..52/53）。

---

## 4. 搜索

- 集成 `LiveSearch`（`emdash/ui/search`）到报头，`collections={["articles","pages"]}`。
- 独立 `/search` 页支持 `?q=` 参数与结果分页。
- 前提：集合 `supports` 含 `search`，字段标 `searchable: true`（已在内容模型定义）。
- Cmd/Ctrl+K 聚焦搜索框。
- 主题化 CSS 变量：`--emdash-search-*`。

---

## 5. RSS

- `/rss.xml.ts` 复用参考实现（`getEmDashCollection` + XML 转义 + `Cache-Control`）。
- 全站 feed 取最新 20~50 篇；分版块 feed 在 `where` 加 `section` 过滤。
- 输出 `<language>zh-cn`，`<lastBuildDate>`，`guid isPermaLink="true"`。
- 可选：`/rss.xml` 与 `/atom.xml` 二选一或并存。

---

## 6. 组件清单

| 组件 | 职责 |
| --- | --- |
| `Base.astro` | HTML 骨架、报头、页脚、`EmDashHead`/`EmDashBodyStart`/`EmDashBodyEnd`、主题初始化脚本 |
| `Masthead.astro` | 报头：站名（衬线大字）、日期、天气位、订阅入口 |
| `NavBar.astro` | 版块导航（来自 `primary` menu） |
| `LeadStory.astro` | 头条（大图 + 引题/主题/副题） |
| `StoryCard.astro` | 列表卡片（含 `is_breaking` 角标、来源、时间） |
| `SectionBlock.astro` | 首页版块区块（取某 section 前 N 篇） |
| `Gallery.astro` | 图片新闻图集（网格/瀑布流 + 图注 + 摄影署名） |
| `Lightbox.astro` | 全屏灯箱（键盘/触屏切换） |
| `PhotoGrid.astro` | 头版图片新闻区块 |
| `ArchiveNav.astro` | 月/周切换 + 年月选择 |
| `Pagination.astro` | offset 分页控件 |
| `Byline.astro` | 署名（多作者 + 角色标签） |
| `ArticleMeta.astro` | 日期、来源、阅读时长、分享 |
| `SubscribeForm.astro` | 邮件订阅表单（对接订阅 API） |
| `CommentSection.astro` | 包装 `Comments` + `CommentForm` |
| `CorrectionNotice.astro` | 更正声明 |
| `Footer.astro` | 页脚菜单 + 版权 + RSS 链接 |

---

## 7. 页面模式要点

### 头版 `/`
```astro
const [{ entries: lead }, { entries: latest }] = await Promise.all([
  getEmDashCollection("articles", { where: { is_featured: true }, orderBy: { published_at: "desc" }, limit: 1 }),
  getEmDashCollection("articles", { orderBy: { published_at: "desc" }, limit: 12 }),
]);
// 各 section 区块：for each section term → getEmDashCollection(..., { where: { section: term.slug }, limit: 4 })
// 图片新闻区块：getEmDashCollection("articles", { where: { article_type: "photo" }, limit: 6 }) → <PhotoGrid>
```

### 文章页 `/articles/[slug]`
```astro
const { entry: article } = await getEmDashEntry("articles", slug);
if (!article) return Astro.redirect("/404");
const seo = getSeoMeta(article, { siteTitle, siteUrl: Astro.url.origin, path: `/articles/${slug}` });
const tags = article.data.terms?.tag ?? [];
```
- 用 `article.edit.*` 属性支持可视化编辑。
- 评论：`<Comments collection="articles" contentId={article.data.id} threaded />`（注意用 `data.id`）。
- 仅当 `article.data.allow_comments !== false` 渲染评论区。

### 版块页 `/sections/[slug]`
```astro
const termsResult = await getTaxonomyTermsWithCacheHint("section", { includeCounts: true });
const term = termsResult.data.find(t => t.slug === slug);
const { entries } = await getEmDashCollection("articles", { where: { section: slug }, orderBy: { published_at: "desc" }, limit: 20 });
```

---

### 图片新闻（`article_type === "photo"`）
```astro
const { entry: article } = await getEmDashEntry("articles", slug);
const isPhoto = article?.data.article_type === "photo";
const gallery = article?.data.gallery ?? [];
```
- 头版：`PhotoGrid` 区块展示图片新闻（主图 + 标题叠加）。
- 文章页：主图全宽 + 图集网格（`Gallery`）+ 灯箱（`Lightbox`）；图注/摄影署名 (`photo_credit`) 必显。
- 响应式：桌面 3 栏图集、平板 2 栏、移动 1 栏；`loading="lazy"` + `srcset`。
- 图集项结构：`{ image, caption, credit }`（见 [03-content-model.md](./03-content-model.md#2-articles-字段定义)）。

### 期号页 `/editions/[slug]`
```astro
const { entry: edition } = await getEmDashEntry("editions", slug);
const { entries: articles } = await getEmDashCollection("articles", {
  where: { edition: edition.data.id },   // reference 字段；若用 slug 关联则按实际字段
  orderBy: { published_at: "desc" }, limit: 50,
});
```
- 展示本期封面、导读、按版块分组的文章。

## 8. 缓存策略

- 每个内容查询把 `cacheHint` 交给 `Astro.cache.set()`。
- 设置/菜单/taxonomy/widget 用 `*WithCacheHint` 变体。
- 发布/更新会自动失效相关缓存（EmDash 处理）。

## 9. SEO 与结构化数据

- `getSeoMeta()` 生成 title/description/canonical/og。
- 文章页注入 `NewsArticle` JSON-LD（可用 `page:metadata` 钩子或直接写在 `Base.astro`）。
- `robots.txt` / `sitemap` 由 EmDash `siteUrl` 驱动。
- RSS `<link rel="alternate">`。

## 10. 无障碍与性能

- 语义标签：`<article>`、`<nav>`、`<time datetime>`、`<figure>/<figcaption>`。
- 图片：`<Image>` + 响应式 + `loading="lazy"` + 必填 `alt`（图注字段）。
- 首屏主题脚本 `is:inline` 防闪烁。
- 字体子集化（Astro fonts 配置），避免布局抖动。
- 目标：LCP < 2.5s，CLS < 0.1。

## 11. 响应式断点

| 断点 | 布局 |
| --- | --- |
| ≥ 1200px | 3 栏（左署名 / 正文 / 右侧栏），头版 3~4 栏网格 |
| 768–1199px | 2 栏，侧栏折叠到正文下方 |
| < 768px | 单栏，报头精简，导航抽屉 |
