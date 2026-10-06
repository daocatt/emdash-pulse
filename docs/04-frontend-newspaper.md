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
- **JSON-LD 由 `pulse-seo` 插件统一贡献**（`page:metadata` 钩子，`id: "primary"`）：文章页 `NewsArticle`，其余页 `WebSite`。模板**不再**手工注入 JSON-LD（`Base.astro` 的 `jsonLd` 属性已移除）。
  - 原因：EmDash `<EmDashHead>` 本身会为公开页面自动输出一份 JSON-LD，模板再注入一份会造成同页两个冲突实体。`page:metadata` 按 `id` 首个胜出、插件排在 base 之前，故可覆盖。
- 文章页社交图：`og:image` 取 SEO 面板图，缺省回退到题图（`featured_image`）并补成绝对 URL（`getSeoMeta` 本身不回退到题图）。
- `robots.txt` / `sitemap.xml` **项目覆盖**（EmDash 允许同名文件覆盖其内置路由）：
  - `/sitemap.xml`：索引 EmDash 的集合 sitemap（articles/pages/editions，仍由 `/sitemap-[collection].xml` 生成）+ 新增的 `/sitemap-sections.xml`、`/sitemap-tags.xml`（只列 `count>0` 的分类页）。
  - `/robots.txt`：EmDash 默认规则 + `Disallow: /spike/`；若后台配置了 `seo.robotsTxt` 则以其为准。
  - 路径必须保持原样：EmDash 中间件把 `/sitemap.xml`、`/robots.txt`（及 `/sitemap-*.xml`）列入公共运行时白名单，才会注入 `locals.emdash.db`。
- RSS `<link rel="alternate">`。

## 10. 无障碍与性能

- 语义标签：`<article>`、`<nav>`、`<time datetime>`、`<figure>/<figcaption>`。
- **图片一律走 `emdash/ui` 的 `<Image image={...}>`**（不再手写 `<img>`）：由 Astro 的 image service（本地 `sharp` / 生产 Cloudflare Images）生成 `srcset`（640–3200w）、`sizes`、`width`/`height`、WebP 转换与 LQIP 占位。
  - `sizes` 按各组件真实栅格宽度显式给出（头版 58vw / 卡片 33vw / 正文列 680px），避免默认 `100vw` 造成过度下载。
  - 首屏图（头版主图、文章 hero、图片新闻首格、合辑封面）传 `priority` → `loading="eager"` + `fetchpriority="high"`。
  - **`image.remotePatterns` 必须包含站点自身 origin**（见 `astro.config.mjs`）：EmDash 把同源媒体路径解析成绝对 URL 交给 Astro，未授权时生产构建会静默退回原图（srcset 各档位指向同一张全尺寸图）。
- **字体：纯系统字体栈，零 webfont**。`--font-heading` 的 `"Source Serif 4"` / `"Noto Serif SC"` 与 `--font-mono` 的 `"JetBrains Mono"` 仅在本机安装时生效，否则回退到系统衬线/等宽（宋体、Georgia、Menlo 等）。因此无需子集化，也不产生字体请求。
  - 构建产物里出现的 16 个 woff2（约 944 KB）属于**后台编辑器**（CodeEditor 等懒加载 chunk），公开页面不加载它们（已实测：公开页只加载 2 个 CSS ≈ 31 KB + 一个搜索脚本）。
- 首屏主题脚本 `is:inline` 防闪烁。
- 目标：LCP < 2.5s，CLS < 0.1。CLS 由「容器 `aspect-ratio` + `<Image>` 输出的 `width`/`height`」双重保障。

## 11. 响应式断点

| 断点 | 布局 |
| --- | --- |
| ≥ 1200px | 3 栏（左署名 / 正文 / 右侧栏），头版 3~4 栏网格 |
| 768–1199px | 2 栏，侧栏折叠到正文下方 |
| < 768px | 单栏，报头精简，导航抽屉 |

---

## 12. 实施记录（Phase 2）

### 已落地文件

| 类别 | 文件 |
| --- | --- |
| 主题 | `src/styles/tokens.css`（报纸令牌）、`src/styles/theme.css`（身份覆盖 + 全局排版 + `.prose`） |
| 布局 | `src/layouts/Base.astro`（报头/导航/页脚/灯箱/防闪烁；JSON-LD 交给 `pulse-seo` 插件） |
| 组件 | `Masthead`、`NavBar`、`Footer`、`Byline`、`ArticleMeta`、`StoryCard`、`LeadStory`、`SectionBlock`、`Gallery`、`Lightbox`、`PhotoGrid`、`Pagination`、`ArchiveNav`、`CorrectionNotice` |
| 工具 | `date-range`（月/周）、`format`（时区/ISO 周/阅读时长）、`media`（图片/图集解析）、`sitemap`（XML 渲染）、`types`、`text`、`archive`、`archive-nav`、`search`、`site-identity` |
| 页面 | `index`、`articles/[slug]`、`sections/[slug]`、`tags/[slug]`、`editions/[slug]`、`pages/[slug]`、`archive/*`、`search`、`rss.xml`、`feed.json`、`sitemap.xml`（+ `sitemap-sections.xml`/`sitemap-tags.xml`）、`robots.txt`、`404` |

### 与原设计的偏差

1. **期号归属改用 taxonomy**：`articles.edition` 由 **reference 字段** 改为 **taxonomy `edition`**（术语 slug 与 `editions` collection 的 slug 一致）。原因：EmDash 不支持按 reference 字段过滤/排序，期号页无法反查本期文章。详见 `03-content-model.md` §3 与 `10-phase0-report.md`。
2. **中文搜索需要 trigram**：FTS 默认 `porter unicode61` 不支持中文分词；用 `scripts/configure-search.mjs` 切换为 `trigram`（≥3 字精确），并对 1–2 字查询提供内存回退。
3. **归档分页用 `?page=`**：未引入 `/page/[n]` 路由，减少路由数；`Pagination` 组件统一生成 `?page=N`。
4. **报头日期为动态**：`Masthead` 用 `Intl`（`Asia/Shanghai`）渲染当天日期，不依赖内容。

### 待办（后续 Phase）

- [x] `/subscribe` 订阅页与 `SubscribeForm`（Phase 3）—— 另含 `/subscribe/confirm`、`/subscribe/unsubscribe` 结果页与页脚/头版入口。
- [x] 评论样式细化（Phase 3，`emdash/ui/comments` 的 `--ec-*` 覆盖）。
- [ ] 分版块 RSS `/sections/[slug]/rss.xml`（可选）。
- [x] 性能复核（Phase 5）：全站改用 `emdash/ui` 的 `<Image>`（响应式 `srcset`/`sizes`/宽高/WebP/LQIP），首屏图 `priority`；`image.remotePatterns` 修复生产环境 srcset 退化；字体决策为纯系统栈（无需子集化）。
- [ ] 真机移动端复核（Lighthouse 实测 LCP/CLS）。
