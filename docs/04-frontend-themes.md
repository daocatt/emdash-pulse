# 04 · 前台双主题（Themes）

前台是**自研 Astro 主题**，仅复用参考项目的工程结构（`Base.astro`、RSS、站点标识工具），视觉与布局从零设计。

仓库里**同时存在两套完整主题**：

- **构建期默认值**：`SITE_THEME` 决定哪套是「默认主题」，它注册在干净路径上；
- **运行期切换**：后台「前台主题」页（沙箱插件 `pulse-theme`）可以把**另一套**设为当前主题，切换后立即全站生效，无需重新部署（见 §1.1）。

任一时刻只**渲染**一套。

| 主题 | 设计来源 | 目录 | 视觉语言 |
| --- | --- | --- | --- |
| `news-factory`（默认） | 设计稿 UI-1 | `src/themes/news-factory/` | 报纸头版：深红强调、细横线、三栏网格、圆角 2px |
| `pulse-news` | 设计稿 UI-2 | `src/themes/pulse-news/` | 杂志：米白纸色 + 纸纹噪点、陶土红/粉强调、大留白、粗斜体衬线标题、圆角 6–10px |

```bash
npm run dev                        # 默认 news-factory（后台可切到 pulse-news）
SITE_THEME=pulse-news npm run dev  # 改构建期默认值为 pulse-news
npm run build:news-factory         # = plugin:build + SITE_THEME=... astro build
npm run build:pulse-news
npm run typecheck:all              # 两套默认值各跑一次 astro check
```

---

## 1. 主题路由与运行期切换

主题页面**不是** `src/pages/` 下的文件路由，而是 `astro.config.mjs` 里的 `THEME_ROUTES` + `themeRoutes()` integration 在 `astro:config:setup` 阶段用 `injectRoute()` 注入的。

**默认主题**注册在干净路径上，**另一套**注册在带前缀的 `/_t/<theme>/…`：

```js
const THEME_NAMES = ["news-factory", "pulse-news"];
const DEFAULT_SITE_THEME = process.env.SITE_THEME ?? "news-factory";
const THEME_PREFIX = "/_t";

// 14 条人类页面，见 §5 路由表
const THEME_ROUTES = [["/", "pages/index.astro"], /* … */];

function themeRoutes() {
  return {
    name: "suda-pulse:theme-routes",
    hooks: {
      "astro:config:setup": ({ injectRoute }) => {
        for (const name of THEME_NAMES) {
          const prefix = name === DEFAULT_SITE_THEME ? "" : `${THEME_PREFIX}/${name}`;
          for (const [pattern, rel] of THEME_ROUTES) {
            const entrypoint = `src/themes/${name}/${rel}`;
            if (!existsSync(fileURLToPath(new URL(entrypoint, import.meta.url)))) {
              throw new Error(`主题 "${name}" 缺少路由 ${pattern} 的页面：${entrypoint}`);
            }
            injectRoute({ pattern: `${prefix}${pattern}`, entrypoint });
          }
        }
      },
    },
  };
}
```

### 1.1 运行期切换（后台「前台主题」页）

| 环节 | 位置 | 做什么 |
| --- | --- | --- |
| 写 | `plugins/pulse-theme`（沙箱） | 后台页 Block Kit `radio` → `ctx.settings.set("theme", …)`，落 options 表 `plugin:pulse-theme:settings:theme` |
| 读 | `src/middleware.ts`（宿主信任代码） | `getPluginSetting("pulse-theme", "theme")`；取不到 / 非法则回退 `__DEFAULT_SITE_THEME__` |
| 生效 | `src/middleware.ts` | 当前主题 === 默认 → 直接 `next()`；否则把干净路径 rewrite 到 `/_t/<theme>/…` |

`__DEFAULT_SITE_THEME__` 由 `astro.config.mjs` 的 `vite.define` 烘进产物（Node / Workers 两种运行时都能读到，不依赖 `process.env`）。

中间件的四条硬约束（改之前先读 `src/middleware.ts` 顶部注释）：

1. **必须用 `next(payload)`**，不能用 `context.rewrite()` —— 后者走 `executeRewrite` → `handleMiddleware`，会**重跑整条中间件链**（重复执行 EmDash 中间件 + 递归回本文件）。
2. EmDash 的内置中间件全部是 `order: "pre"`，本中间件**排在最后**，所以 EmDash 的 redirect / setup / auth 看到的始终是原始路径（`locals.emdash.db` 注入、redirect 命中、404 记账都不受影响）。
3. **rewrite 不保留查询串**，必须显式拼 `context.url.search`。
4. **rewrite 会改写 `Astro.url`**：主题页面里取路径一律用 `Astro.originPathname`（canonical / JSON-LD `path` / `isHome` / 导航高亮 / 语言切换）；`Astro.url.origin` 与 `Astro.url.searchParams` 不受影响。

**默认主题留在干净路径上**不只是为了省一次 rewrite：只有干净路径能命中路由，`routePattern` 才会是真实页面的 pattern；否则所有请求都会落到 `/404` 路由，中间件无法区分「真 404」与「正常页面」。因此 `/_t/<theme>/404` 必须单独注册，并在 rewrite 后把状态码改回 404（rewrite 会把 `state.status` 重置为 200）。

`/_t/**` 只作内部命名空间：直接访问会被中间件 302 回干净路径，`robots.txt` 也 `Disallow: /_t/`。

**新增人类页面时必须同时**：① 在 `THEME_ROUTES` 注册；② **两套主题各放一份同路径文件**（缺文件会在 `astro:config:setup` 直接抛错）。

`src/pages/` 只保留**主题无关的机器端点**：`rss.xml` / `feed.json` / `sections/[slug]/rss.xml` / `llms.txt` / `robots.txt` / `sitemap*.xml` / `agent/**` / `spike/**`。

### 为什么不用「Vite alias + `src/pages` 薄转发层」

转发层里主题页是**子组件**而非路由组件，Astro 7.3.5 下 `Astro.redirect()` **静默失效**（子组件返回的 `Response` 被当普通值写出，不短路）。`articles` / `editions` / `pages` / `sections` / `tags` 五处都在用 `return Astro.redirect("/404")`，所以这是唯一但致命的硬伤。

### 为什么不用「改 `srcDir`」

`src/live.config.ts` 必须在 `srcDir/live.config.ts`（Astro content runtime 强制）；Cloudflare adapter 的 worker 入口默认也在 srcDir；EmDash 用 `srcDir/pages/` 检测用户是否覆盖了 `robots.txt` / `sitemap.xml`。

---

## 2. 目录结构

```
src/
├── components/              # 共享组件（主题无关，仅令牌换肤）  → @shared
│   ├── AuthorCard.astro          # 头像（或首字色块）+ 姓名 + 角色 / 日期
│   ├── EpisodePlayer.astro       # 播客 / 视频播放块（有 src 走原生控件，否则装饰态）
│   ├── Byline / ArticleMeta / CorrectionNotice / Gallery / Lightbox
│   └── Pagination / ArchiveNav / SubscribeForm / LanguageSwitcher
├── styles/
│   ├── tokens.base.css      # 令牌「契约」：共享组件消费的所有变量名 + 中性默认值（@layer base）
│   └── base.css             # reset + 全局元素 + .prose / .container / .kicker + 评论 --ec-*
├── i18n/                    # UI 文案多语言
│   ├── index.ts             # resolveLocale / createTranslator / getTranslations / localeHref / menuLabel
│   ├── zh-CN.ts             # 中文字典（默认，键的源头）
│   └── en.ts                # 英文字典（Record<MessageKey, string>，漏键即编译失败）
├── utils/                   # 主题无关数据层  → @utils
│   ├── types.ts             # InferCollectionData<...> 的别名
│   ├── query.ts             # whereClause()：布尔字段过滤的类型收窄
│   ├── byline.ts / media.ts / format.ts / text.ts
│   ├── date-range.ts / archive.ts / archive-nav.ts
│   ├── search.ts / site-identity.ts / sitemap.ts / theme.ts
│   └── agent*.ts / rate-limit.ts / subscriptions.ts
├── themes/
│   ├── news-factory/
│   │   ├── theme.config.ts      # defineTheme({ name, label, menuName, footerMenuName })
│   │   ├── layout/Base.astro
│   │   ├── components/          # TopBar / Masthead / MainNav / TextBrief / MainStory
│   │   │                        # InlineStory / RankList / VideoCard / MoreStories / StoryCard / Footer
│   │   ├── styles/{tokens.css, theme.css}
│   │   └── pages/**             # 14 个人类页面
│   └── pulse-news/
│       ├── theme.config.ts
│       ├── layout/Base.astro
│       ├── components/          # Masthead（脉冲标 + 竖排站名 + 汉堡）/ SectionHeading（手绘下划线）
│       │                        # SpotlightCard / MainFeature / MiniCard / StoryGrid
│       │                        # PodcastBlock / AsideStory / Footer
│       ├── styles/{tokens.css, theme.css}   # theme.css 含纸纹（feTurbulence 噪点）
│       └── pages/**             # 14 个人类页面
└── pages/                       # 只留主题无关的机器端点
```

**分层原则**：查询 / SEO / 缓存 / 媒体解析 / 日期区间**一律不进主题目录**（收敛到 `src/utils/`）；主题目录只放「布局 + 视觉组件 + 令牌 + 页面拼装」。

**跨目录引用共享层用别名**（两处必须同步）：

| 别名 | 目标 | 配置位置 |
| --- | --- | --- |
| `@shared/*` | `src/components/*` | `astro.config.mjs` 的 `vite.resolve.alias` + `tsconfig.json` 的 `paths` |
| `@utils/*` | `src/utils/*` | 同上 |

主题内引用 i18n / 令牌用**相对路径**（如 `../../../i18n`）—— `injectRoute` 的 entrypoint 是主题目录下的真实文件，相对路径层级随页面深度变化。

---

## 3. 令牌与样式分层

**共享契约 + 每主题覆盖**（不是每套完整一份）：

| 文件 | 作用 |
| --- | --- |
| `src/styles/tokens.base.css` | 在 `@layer base` 内**声明所有共享组件会消费的变量名**（颜色 / 字体 / 字号阶梯 / 行高 / 字距 / 间距 / 宽度 / 圆角 / 分隔线 / `--emdash-search-*` / `--ec-*`），给中性默认值。颜色用 `light-dark()`。 |
| `src/themes/<theme>/styles/tokens.css` | **不在 layer 内**（因此总是覆盖 base），覆盖成该主题的调色 / 字体 / 圆角 / 间距 / 线型。 |
| `src/styles/base.css` | 全局元素 + `.prose` / `.container` / `.kicker` + 评论主题，两套共享。 |

**两个维度正交**：

| 属性 | 取值 | 载体 |
| --- | --- | --- |
| `data-theme` | `light` / `dark` | 颜色方案。`light-dark()` + `localStorage["suda-pulse-theme"]`，每套 `Base.astro` 里有一段 `is:inline` 防闪烁脚本 |
| `data-site-theme` | `news-factory` / `pulse-news` | 主题标识（写死常量）。仅供 E2E 断言与调试，**不承载样式分支** |

**字体：纯系统字体栈，零 webfont**。`--font-heading` 用 Georgia / Songti SC / STSong / Times New Roman，`--font-mono` 用系统等宽。无需子集化，公开页面不产生字体请求（构建产物里的 woff2 属于**后台编辑器**的懒加载 chunk）。

---

## 4. i18n（只覆盖 UI 文案）

**不打开 Astro 的 `i18n`**：EmDash 只在 Astro 配了多个 locale 时才激活内容翻译链路，而它会按 locale 过滤所有内容查询 —— 现有内容行的 locale 是 `en`，默认语言设成 `zh-CN` 会让列表与详情全部查空。内容**不做翻译**。

| 关注点 | 实现 |
| --- | --- |
| 语言集合 | `zh-CN`（默认）+ `en`，见 `LOCALES` / `DEFAULT_LOCALE` |
| 解析顺序 | cookie `suda-pulse-lang` > `?lang=` > 默认。`?lang=` 是为了首次点击切换链接（cookie 还没写）时也生效 |
| 取值 | `getTranslations(Astro)` → `{ locale, t }`；组件里不需要逐层传 prop |
| 插值 | `t("key", { name: "…" })`，模板里写 `{name}` |
| 缺键 | `zh-CN.ts` 是**键的源头**（`MessageKey = keyof typeof zhCN`）；`en.ts` 是 `Record<MessageKey, string>`，漏一个就编译失败。运行期缺键回退默认语言，再回退键名本身 |
| `<html lang>` | 由 `locale` 决定 |
| 日期 | `@utils/format` 的 `formatDate` / `formatDateTime` / `formatMonthLabel` / `formatWeekLabel` 都接受 `locale`（默认 `zh-CN`） |
| 切换控件 | `@shared/LanguageSwitcher.astro`（`localeHref()` 保留当前查询参数） |
| 菜单标签 | **字典驱动**：后台菜单只提供链接与排序，渲染期用 `menuLabel(url, fallback, t)` 按当前语言取（见 `MENU_LABEL_KEYS`）。表里没有的地址回退菜单自身标签 |
| 机器端点 | RSS / JSON Feed 的 `language` 跟随默认 locale |

**字典组织**：`common.*` / `pagination.*` / `byline.*` / `subscribe.*`（表单状态文案）/ `menu.*` / `archive.*` / `footer.*` / `notFound.*` 为通用键；`nf.*`（news-factory 首页）、`pn.*`（pulse-news 首页）、`list.*` / `article.*` / `edition.*` / `search.*` / `subscribePage.*` 为页面键。

---

## 5. 路由表

14 条人类路由由主题注入（见 §1），机器端点固定在 `src/pages/`：

| 路由 | 说明 |
| --- | --- |
| `/` | 头版 / 首页 |
| `/articles/[slug]` | 文章详情（署名 / 日期 / 正文 / 图集 / 更正 / 标签 / 评论 / 相关） |
| `/sections/[slug]` | 版块归档（taxonomy `section`） |
| `/tags/[slug]` | 标签归档（taxonomy `tag`） |
| `/archive` | 归档总览：按月 / 按周入口 + 最近发布 |
| `/archive/[year]/[month]` | **按月**归档 |
| `/archive/[year]/week/[week]` | **按周**归档（ISO 周） |
| `/editions/[slug]` | **期号**版面（月 / 周报） |
| `/pages/[slug]` | 静态页 |
| `/search` | 全文搜索（`?q=`） |
| `/subscribe` · `/subscribe/confirm` · `/subscribe/unsubscribe` | 邮件订阅（双确认） |
| `/404` | 未找到 |
| `/rss.xml` · `/feed.json` · `/sections/[slug]/rss.xml` · `/llms.txt` · `/robots.txt` · `/sitemap*.xml` | 机器端点（主题无关） |
| `/agent/**` | Agent Read API，见 [09-agent-newsroom.md](./09-agent-newsroom.md#5-agent-read-api-d13) |

---

## 6. 首页数据编排

两套首页都只在页面里做「查询 → `cacheHint` → 去重取用 → 交给纯展示组件」。

### news-factory（UI-1）

```ts
const [latestResult, leadResult, featuredResult, videoResult, trendingResult] = await Promise.all([
  getEmDashCollection("articles", { orderBy: { published_at: "desc" }, limit: 12 }),
  getEmDashCollection("articles", { where: { priority: "lead" }, orderBy: { published_at: "desc" }, limit: 1 }),
  getEmDashCollection("articles", { where: whereClause({ is_featured: true }), orderBy: { published_at: "desc" }, limit: 5 }),
  getEmDashCollection("articles", { where: { article_type: "video" }, orderBy: { published_at: "desc" }, limit: 1 }),
  getEmDashCollection("articles", { where: { trending_rank: { gte: "1" } }, orderBy: { trending_rank: "asc" }, limit: 5 }),
]);
```

版面：左栏 3 条纯文字简讯 + 订阅通讯卡；中栏主稿（大图）+ 2 条图文横排；右栏「热门话题 / 最新更新」双页签排行 + 视频卡；底部「更多头条」。

- 「热门话题」优先按编辑部标记的 `trending_rank` 升序，其次 `is_featured`，仍不足 5 条用最新稿补位。
- `trending_rank` 的 `gte: "1"` 顺带排除未标记的 NULL（SQLite 里 `NULL >= 1` 为假）。
- 布尔字段过滤必须走 `@utils/query` 的 `whereClause()`，见 [AGENTS.md](../AGENTS.md)。

### pulse-news（UI-2）

```ts
const [latestResult, leadResult, podcastResult] = await Promise.all([
  getEmDashCollection("articles", { orderBy: { published_at: "desc" }, limit: 12 }),
  getEmDashCollection("articles", { where: { priority: "lead" }, orderBy: { published_at: "desc" }, limit: 1 }),
  getEmDashCollection("articles", { where: { article_type: "podcast" }, orderBy: { published_at: "desc" }, limit: 1 }),
]);
```

版面：左栏 SPOTLIGHT 米黄卡（4 条）；中栏主视觉（大图 + 超大斜体标题 + 作者卡 + 时间戳 + 摘要）+ 三栏小图卡；右栏播客区块 + 一条侧栏文章。用 `take(n)` 辅助函数按顺序取稿并去重，不够时按设计稿补位。

---

## 7. 按月 / 按周筛选

EmDash `getEmDashCollection` 的 `where` 支持 `WhereRange`：`{ gt, gte, lt, lte }`（**string** 值），日期字段以 ISO 字符串比较。

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

> 时区：站点时区固定 `Asia/Shanghai`（展示用 `Intl` 做换算）；归档边界走 UTC 半开区间。

### 查询示例（按月）

```astro
---
import { getEmDashCollection } from "emdash";
const range = monthRange(Number(Astro.params.year), Number(Astro.params.month));
const { entries, cacheHint, hasMore } = await getEmDashCollection("articles", {
  where: { published_at: range },
  orderBy: { published_at: "desc" },
  limit: 20,
  offset: (page - 1) * 20,
});
if (Astro.cache?.enabled) Astro.cache.set(cacheHint);
---
```

**分页**：归档与列表页统一用 **offset 分页**（`limit` + `offset`）配合 `?page=N`（`Pagination` 组件生成），不引入 `/page/[n]` 路由。**归档导航**：`/archive` 顶部提供「按月 / 按周」切换，`ArchiveNav` 组件提供上一期 / 下一期与年 / 期选择（`buildMonthNav` / `buildWeekNav` 计算）。

---

## 8. 搜索

- 全文搜索走 EmDash 的 `search()`，集合限 `["articles", "pages"]`。
- **中文需要 trigram 分词器**：FTS 默认 `porter unicode61` 不支持中文分词（「内容审核工作流」无法用「审核」命中）。用 `scripts/configure-search.mjs` 把 `_emdash_collections.search_config.tokenize` 改成 `trigram` 并重建索引；**重建库后需要重跑**。
- trigram 要求 ≥ 3 字符，1–2 字的中文查询（如「审核」）走 `@utils/search` 的 `fallbackSearch()` 内存回退扫描，页面标注「（模糊匹配）」。
- 主题化 CSS 变量：`--emdash-search-*`。
- 搜索入口：news-factory 在 `TopBar`；pulse-news 在汉堡菜单面板内。

---

## 9. 组件清单

### 共享（`src/components/`，仅令牌换肤）

| 组件 | 职责 |
| --- | --- |
| `AuthorCard.astro` | 头像（无头像时回退姓名首字色块）+ 姓名 + 角色 / 日期 |
| `EpisodePlayer.astro` | 播客 / 视频播放块：有 `audio_url` / `video_url` 时渲染原生 `<audio>` / `<video>`，否则退化为装饰播放条 + 时长 + 栏目 / 期号 |
| `Byline.astro` | 署名（多作者 + 角色标签 + agent 标识） |
| `ArticleMeta.astro` | 日期、来源、阅读时长 |
| `CorrectionNotice.astro` | 更正声明 |
| `Gallery.astro` + `Lightbox.astro` | 图集（响应式网格 + 图注 + 摄影署名）与全屏灯箱 |
| `Pagination.astro` | offset 分页控件（`?page=N`） |
| `ArchiveNav.astro` | 月 / 周模式切换 + 年月 / 期选择 |
| `SubscribeForm.astro` | 邮件订阅表单（渐进增强，`default` / `card` 两种变体） |
| `LanguageSwitcher.astro` | 语言切换（cookie + `?lang=`） |

### news-factory 专属

`TopBar`（日期 + 搜索 + 登录）、`Masthead`（报头三栏）、`MainNav`（版块导航）、`TextBrief`、`MainStory`、`InlineStory`、`RankList`（双页签排行）、`VideoCard`、`MoreStories`、`StoryCard`、`Footer`。

### pulse-news 专属

`Masthead`（脉冲波形标 + 竖排站名 + 年度订阅 / 登录 / 汉堡菜单，菜单内含搜索与语言切换）、`SectionHeading`（大号粗斜体 + 内联 SVG 手绘下划线）、`SpotlightCard`、`MainFeature`、`MiniCard`、`StoryGrid`、`PodcastBlock`、`AsideStory`、`Footer`。

---

## 10. 页面模式要点

### 文章页 `/articles/[slug]`

```astro
const { entry: article } = await getEmDashEntry("articles", slug);
if (!article) return Astro.redirect("/404");
const seo = getSeoMeta(article, { siteTitle, siteUrl: Astro.url.origin, path: `/articles/${slug}` });
const tags = article.data.terms?.tag ?? [];
```

- 用 `article.edit.*` 属性支持可视化编辑。
- 评论：`<Comments collection="articles" contentId={article.data.id} threaded />`（**用 `data.id`（ULID），不是 `entry.id`（slug）**）；仅当 `article.data.allow_comments !== false` 渲染。
- 相关报道：按第一个 `section` 术语查同版块最新稿并排除自身。
- 播客 / 视频（`article_type` 为 `podcast` / `video`）额外渲染 `EpisodePlayer`。
- news-factory 是三栏（左署名 / 正文 / 右侧栏 `WidgetArea name="article-aside"`）；pulse-news 是居中单栏。

### 图片新闻（`article_type === "photo"`）

- 图集结构：`{ image, caption, credit }`，见 [03-content-model.md](./03-content-model.md)。
- 主图全宽 + `Gallery` 网格 + `Lightbox`；`image_caption` / `photo_credit` 必显。
- 无图集时给出提示（`article.photoNote`）。

### 期号页 `/editions/[slug]`

```astro
const { entries: articles } = await getEmDashCollection("articles", {
  where: { edition: slug },   // taxonomy `edition`，不是 reference 字段
  orderBy: { published_at: "desc" }, limit: 60,
});
```

按 `section` 术语分组展示本期目录。

---

## 11. 缓存策略

- 每个内容查询把 `cacheHint` 交给 `Astro.cache.set()`（页面里统一 `if (Astro.cache?.enabled)`）。
- 设置 / 菜单 / taxonomy / widget 用 `*WithCacheHint` 变体（`getSiteSettingsWithCacheHint`、`getMenuWithCacheHint`、`getTaxonomyTermsWithCacheHint`）。
- 发布 / 更新会自动失效相关缓存（EmDash 处理）。

---

## 12. SEO 与结构化数据

- `getSeoMeta()` 生成 title / description / canonical / og。
- **JSON-LD 由 `pulse-seo` 插件统一贡献**（`page:metadata` 钩子，`id: "primary"`）：文章页 `NewsArticle`，其余页 `WebSite`。模板**不再**手工注入 JSON-LD。
  - 原因：EmDash `<EmDashHead>` 本身会为公开页面自动输出一份 JSON-LD，模板再注入一份会造成同页两个冲突实体。`page:metadata` 按 `id` 首个胜出、插件排在 base 之前，故可覆盖。
- 文章页社交图：`og:image` 取 SEO 面板图，缺省回退到题图（`featured_image`）并补成绝对 URL（`getSeoMeta` 本身不回退到题图）。
- `robots.txt` / `sitemap.xml` **项目覆盖**（EmDash 允许同名文件覆盖其内置路由）：
  - `/sitemap.xml`：索引 EmDash 的集合 sitemap（articles / pages / editions，仍由 `/sitemap-[collection].xml` 生成）+ 新增的 `/sitemap-sections.xml`、`/sitemap-tags.xml`（只列 `count>0` 的分类页）。
  - `/robots.txt`：EmDash 默认规则 + `Disallow: /spike/`；若后台配置了 `seo.robotsTxt` 则以其为准。
  - 路径必须保持原样：EmDash 中间件把 `/sitemap.xml`、`/robots.txt`（及 `/sitemap-*.xml`）列入公共运行时白名单，才会注入 `locals.emdash.db`。

---

## 13. 无障碍与性能

- 语义标签：`<article>`、`<nav>`、`<time datetime>`、`<figure>/<figcaption>`；跳至正文链接；`aria-label` 全部走字典。
- **图片一律走 `emdash/ui` 的 `<Image image={...}>`**（不手写 `<img>`）：由 Astro 的 image service（本地 `sharp` / 生产 Cloudflare Images）生成 `srcset`（640–3200w）、`sizes`、`width`/`height`、WebP 转换与 LQIP 占位。
  - `sizes` 按各组件真实栅格宽度显式给出（主稿 45vw / 卡片 26vw / 正文列 900px），避免默认 `100vw` 造成过度下载。
  - 首屏图（首页主图、文章 hero、期号封面）传 `priority` → `loading="eager"` + `fetchpriority="high"`。
  - **`image.remotePatterns` 必须包含站点自身 origin**（见 `astro.config.mjs`）：EmDash 把同源媒体路径解析成绝对 URL 交给 Astro，未授权时生产构建会静默退回原图（`srcset` 各档位指向同一张全尺寸图）。
- 首屏主题脚本 `is:inline` 防闪烁。
- CLS 由「容器 `aspect-ratio` + `<Image>` 输出的 `width`/`height`」双重保障。
- **公开页 JS 很小**：首屏 eager 只有 `boot`（≈0.6KB gzip）+ Vite 的 preload helper（≈0.8KB gzip）；含 `motion/mini` 的 `runtime.*` chunk（≈4.1KB gzip）延迟到空闲 / 首次交互才请求，且 reduced-motion 下完全不请求（见 §15.1）。

### 13.1 移动端实测（`npm run perf`）

Lighthouse 移动端（412×823、4x CPU + 慢速 4G 模拟），本地构建产物 + 运行期主题切换，每个采样点 3 次取中位数：

| 主题 | 代表路由 | Perf | LCP | CLS | TBT |
| --- | --- | --- | --- | --- | --- |
| news-factory | `/` | 1.00 | 1458ms | 0.000 | 0ms |
| news-factory | `/archive` | 1.00 | 1462ms | 0.000 | 0ms |
| news-factory | `/articles/<slug>` | 0.99 | 1607ms | 0.000 | 0ms |
| news-factory | `/editions/<slug>` | 1.00 | 1387ms | 0.000 | 0ms |
| news-factory | `/sections/<slug>` | 0.98 | 1468ms | 0.000 | 170ms※ |
| pulse-news | `/` | 1.00 | 1451ms | 0.000 | 0ms |
| pulse-news | `/archive` | 1.00 | 1559ms | 0.000 | 0ms |
| pulse-news | `/articles/<slug>` | 1.00 | 1388ms | 0.000 | 0ms |
| pulse-news | `/editions/<slug>` | 1.00 | 1373ms | 0.000 | 0ms |
| pulse-news | `/sections/<slug>` | 1.00 | 1377ms | 0.000 | 0ms |

※ 该格是 3 次采样的方差离群点：单独跑 `--runs=5` 复测同一路由为 **TBT 0ms / Perf 1.00**。其余格子与改造前基线（LCP 1364–1595ms）差异在噪声内 —— 本站在改造前 TBT 已是 0，动效改造的收益主要体现在**下载量与不阻塞首屏**，而不是这些分数。

阈值表（脚本内置，任一越界即退出码 1）：LCP ≤ 2500ms、CLS ≤ 0.1、TBT ≤ 200ms、Perf ≥ 0.9。

---

## 14. 响应式断点

| 断点 | news-factory | pulse-news |
| --- | --- | --- |
| ≥ 1040px | 头版 3 栏（3fr / 5fr / 3fr）+ 栏间细线；文章页 3 栏（署名 / 正文 / 侧栏） | 首页 3 栏（3fr / 6fr / 3fr）；文章页居中单栏（820px） |
| 640–1039px | 单栏；文章页侧栏折到正文下方 | 首页 2 栏；小图卡 2 列 |
| < 640px | 单栏，报头精简，导航换行 | 单栏，报头精简，导航抽屉（`<details>`） |

---

## 15. 动效

前台动效是**一层 data 属性驱动的单例运行时**，用 `motion` 的 **vanilla DOM API**（无 React、无 island）。

只从 **`motion/mini`** 引入（`animate`，WAAPI 版）。完整版 `motion` 会把动画引擎打进每个页面的公共 chunk —— 实测 `dist/client/_astro`：完整版 **21.4KB gzip**（引擎）+ 2.4KB（运行时）；换成 mini 后共享 chunk **3.2KB gzip**，加运行时与灯箱脚本共 **≈5.2KB**（预算 ≤ 12KB）。mini 没有 `inView` / `stagger` / `press`，替代方案见 15.1 / 15.4。

**延迟加载后（现状）**：首屏 eager JS 只剩 `boot` + Vite 的 preload helper（**≈1.5KB gzip**）；含 `motion/mini` 的 `runtime.*` chunk（**≈4.2KB gzip**）改由空闲 / 首次交互触发的动态 `import()` 拉取（实测 `runtime` 的 `startTime` 晚于 `boot`，且 reduced-motion 下完全不请求）。灯箱组件去掉 motion 依赖后其脚本已小到被 Astro 内联进 HTML，不再单独成请求。

### 15.1 架构

```
src/scripts/motion/
├── boot.ts           # 延迟引导（无 motion）：两道门 + idle/交互触发 + 动态 import
├── reduced-motion.ts # reduced 状态与订阅（无 motion，boot 与各 init 共用）
├── runtime.ts        # 运行时（含 motion）：逐个 init + 失败兜底，只由 boot 动态引入
├── tokens.ts         # 从 CSS 自定义属性读 时长/缓动/位移/错峰
├── reveal.ts         # 滚动进场（原生 IntersectionObserver + animate）
├── disclosure.ts     # <details> 开合（拦截 summary click）
└── lightbox.ts       # 灯箱开合（与组件用 DOM 事件解耦）

src/components/MotionRuntime.astro   # 只含一个 <script>，引 boot.ts，挂在两套 Base
```

**延迟加载**：`boot.ts` 过两道门 —— ① 非 reduced-motion；② 页面里真有动效目标（`[data-reveal]` / `details[data-motion-disclosure]` / `[data-motion-lightbox]`）。通过后先 `requestIdleCallback`（回退 `setTimeout`）等空闲，用户先滚动 / 按下 / 按键则立刻加载，最后 `import("./runtime")`。**`runtime.ts` 只能被 boot 动态 import**，静态引用会让延迟加载失效。

> 两道门里第 ② 道是结构性的安全网：本站在**两套主题的导航**里都有 `<details data-motion-disclosure>`（news-factory 的子菜单、pulse-news 的汉堡菜单），所以实际上**每个页面都命中**，真正省下的是「不阻塞首屏」而不是「不下载」。第 ① 道（reduced-motion 完全不下载）才是能实测到零请求的那道门。

组件侧**只加 `data-*`**，命令式动画只写在运行时里：

| 属性 | 作用 |
| --- | --- |
| `data-reveal` | 该容器随滚动渐显（首屏元素自动跳过） |
| `data-reveal-stagger` | 对**直接子元素**逐个错峰（不加则整块进场） |
| `data-motion-disclosure` + `data-motion-panel` | `<details>` 开合动效 |
| `data-motion-lightbox` | 灯箱（配合组件的 `lightbox:open` / `lightbox:close-request` 事件） |
| `data-press` | 按压反馈（纯 CSS `:active`，见 15.4） |
| `data-hover-lift` | 卡片 hover 抬升（纯 CSS，见 15.4） |

### 15.2 强度是主题令牌

`--motion-*` 默认值在 `src/styles/tokens.base.css`，两套主题在各自 `styles/tokens.css` 覆盖。**JS 不判断主题名**，一律 `getComputedStyle` 读令牌，所以新增主题只改 CSS。

| 令牌 | news-factory（克制） | pulse-news（明显） |
| --- | --- | --- |
| `--motion-duration-fast` | `90ms` | `160ms` |
| `--motion-duration-base` | `140ms` | `260ms` |
| `--motion-duration-slow` | `220ms` | `460ms` |
| `--motion-ease` | `cubic-bezier(0.2, 0, 0, 1)` | `cubic-bezier(0.22, 1, 0.36, 1)` |
| `--motion-shift-sm` / `-md` | `2px` / `6px` | `6px` / `16px` |
| `--motion-stagger` | `24ms` | `70ms` |
| `--motion-hover-lift` | `2px` | `4px` |

`--motion-ease` 存成 `cubic-bezier(...)` 是为了 CSS transition 也能直接用；JS 侧解析成四元组喂给 `animate()`。

### 15.3 四条硬约束

1. **滚动进场的隐藏态只能由 JS 加**。SSR HTML / CSS 里绝不出现初始隐藏样式 —— `Astro.cache` 会缓存 HTML，且无 JS / 爬虫必须看到全部内容。做法：SSR 只有静态 `data-reveal` 属性 → 运行时**跳过已在视口内的元素**（`rect.top < innerHeight`，保护 LCP）→ 其余元素设 `opacity: 0` 并在同一 tick 注册 `IntersectionObserver` → 进场结束清除内联样式。任何一步抛错都兜底还原（含一个超时兜底）。判据从 `innerHeight * 0.9` 收紧到 `innerHeight`，是因为运行时延迟加载，初始化时用户可能已滚过一段 —— 把视口下缘那 10% 也算进「要隐藏」会「闪一下再动画」。
2. **`prefers-reduced-motion` 要管两遍**。`src/styles/base.css` 的全局兜底只覆盖 CSS transition / animation；`animate()` 是 JS/WAAPI 驱动，管不到。`boot.ts` 用 `matchMedia` 早退 —— reduced-motion 下**整个运行时都不加载**（也就不设隐藏态）；各 init 仍以 `prefersReducedMotion()` 二次早退（防运行时中途被动态改设置）。CSS 侧的 `data-hover-lift` / `data-press` 位移也在同一个媒体查询里显式关掉。
3. **一条属性只能有一个驱动源**。滚动进场由 `motion` 写内联 `transform`，所以卡片 hover 抬升用独立的 **`translate`**、按压反馈用独立的 **`scale`** —— 都是与 `transform` 叠加而非覆盖的独立属性；进场结束还会清除内联 `transform` 归还给 CSS。反过来，被 CSS 占了 `translate` 的元素（如 `.main-nav__panel` 的横向居中）只能把动效放到 `transform` 上。
4. **keyframe 名必须是真实 CSS 属性**。`motion/mini` 的 `animate()` 不做 shorthand 映射：它把 keyframe 的属性名直接交给 WAAPI，`y` / `x` 不是合法 CSS 属性，会被**静默忽略**（只在内联 `style` 上留一条无效的 `y: 0px`）——位移全丢、只剩淡入。所以位移一律写 `transform: ["translateY(6px)", "translateY(0px)"]`（或真实属性 `translate`），`opacity` / `height` / `scale` 可直接用。**排查手法**：动画进行中读 `getComputedStyle(el).transform`；只看 `element.style` 会被 WAAPI 骗（WAAPI 不写内联样式）。

### 15.4 CSS 与 motion 的分工

| 交互 | 归属 | 理由 |
| --- | --- | --- |
| 链接 / 导航 hover（颜色、下划线、border） | CSS | 零 JS、GPU 友好、天然被 reduced-motion 兜底 |
| 卡片图片 zoom（`scale(1.03)`） | CSS | 已有实现 |
| 卡片 hover 抬升（`data-hover-lift` → `translate`） | CSS | 数量多必须便宜；一条规则覆盖全站 |
| 按钮按压（`data-press` → `:active { scale: 0.97 }`） | CSS | `:active` 就是语义本身，不必为它引一段 JS 手势；`scale` 与 `transform` 叠加不冲突 |
| 灯箱上一张 / 下一张淡入（`.lightbox__image--swap`） | CSS | 单个 class + keyframes，动画结束自动回到无驱动状态；让灯箱组件不依赖 motion |
| `<details>` 开合、灯箱开合、滚动进场 | motion（mini，延迟加载） | 需要测量 / 时序 / WAAPI |

### 15.5 灯箱

`src/components/Lightbox.astro` 是单例 `<dialog>`，`data-lightbox*` 属性 + document 事件委托触发。开合有动效（`close()` 会立即移除对话框，所以关闭动画必须播完再关；Esc 的 `cancel` 事件被拦截后走同一流程）。`aria-label` 与图集的「查看第 N 张图片」走 `lightbox.*` 字典键。

**挂载范围**：**不放在 `Base.astro`**，而是两套主题的 `pages/articles/[slug].astro` 与 `pages/editions/[slug].astro` 各自渲染（共 4 个模板）—— 判据就是下面「触发范围」里那三类触发器只出现在这些页面。这样其余页面不必为它多下一段脚本。新增带图页面若要灯箱，必须自己挂。

**触发范围**：图集（`Gallery.astro`）、文章 hero、期号封面。**卡片图不接** —— 它们包在 `<a href="/articles/…">` 里，接灯箱会与跳转冲突。

**上一张 / 下一张**的淡入是**本地 CSS keyframes**（`.lightbox__image--swap` + `@keyframes lightbox-fade-in`），组件不依赖 motion。开合（进场 / 退场）仍由运行时驱动 `figure`（`opacity` + `scale`），与前者是不同元素、不同属性，不违反「一条属性一个驱动源」。

**降级**：运行时就绪前点开灯箱 → `lightbox:open` 无人监听 → 灯箱正常打开但没有进场动画；关闭时 `close-request` 返回 `true` → 组件走原生 `dialog.close()`。无 JS / 减动效走同一路径。

---

## 16. 实施记录

### P0–P6 阶段

| 阶段 | 内容 | 提交 |
| --- | --- | --- |
| P0 | 主题骨架与 `SITE_THEME` 切换机制（`injectRoute`） | `2e0cda0` |
| P1 | 令牌契约 + i18n 层 + `AuthorCard` | `91750d0`、`a7d3a28` |
| P2 | news-factory 外壳与头版；修复布尔 `where` 类型缺口 | `d5de186`、`7ee4095`、`e84fe5d`、`082c38d` |
| P2 后续 | 中文字号阶梯调整；菜单标签字典驱动 | `e35ce9c`、`ae74584` |
| P3 | pulse-news 外壳与杂志头版 | `363606e`、`6fd1c04` |
| P4 | 内容模型扩展（podcast / video / trending）+ 重建本地库 | `75349b4`、`f26d9a6`、`d5ec0de` |
| P5 | 两套主题的其余 13 个页面 + news-factory 页面本地化 | `be99ddf`、`822a18c`、`ef73de1`、`f37c9b2`、`d9a73db` |
| P6 | 本文档（由 `04-frontend-newspaper.md` 改写）+ 其他文档同步 | `6de24ff`、`043b5d2` |
| P7 | 运行期主题切换（`pulse-theme` 后台页 + `src/middleware.ts` 前缀路由 rewrite） | `d83c461`、`8a50e10`、`9d502ce` |
| P7 修复 | 后台「前台主题」页 502 `INVALID_BLOCK_RESPONSE`：`radio` 是 Block Kit **元素**，需包在 `actions` 块里，不能直接放进顶层 `blocks[]` | `05c5079`、`73f24a8` |
| P7 后续 | 署名行紧凑化（去掉米黄卡片，改单行 `头像 + 姓名 · 角色 · 日期`）；列表卡无主图时不再渲染空占位框 | `2b3d213`、`2203903` |
| P7 后续 | seed 补 8 篇科技版块文章（含 6 个新标签与 `2026-w42` 期号） | `2e9f4ff` |
| P8 | 前台动效层：`motion/mini` 单例运行时（滚动进场 / `<details>` 开合 / 灯箱）+ 主题动效令牌 + 卡片 hover 抬升与按钮按压（CSS） | 见下 |
| P8 后续 | 灯箱接入文章 hero 与期号封面、`lightbox.*` 字典键、折叠菜单外部点击收合 | 见下 |
| P8 复核 | 无头浏览器（CDP）逐主题实测：进场 / 下拉 / 灯箱动画与减动效早退；修复 `y` shorthand 失效与子菜单挂错菜单 | 见下 |
| P9 | 分版块 RSS + feed 发现链接；播客 / 视频外部媒体接入；动效运行时**延迟加载** + 灯箱收窄到 4 个模板；`npm run perf`（Lighthouse 移动端脚手架） | 见下 |

### 与原设计的偏差

1. **主题从 `maple-news` 改名 `pulse-news`**：按出版物命名而非设计稿占位标签。
2. **期号归属用 taxonomy**：`articles.edition` 由 **reference 字段**改为 **taxonomy `edition`**（术语 slug 与 `editions` collection 的 slug 一致）。原因：EmDash 不支持按 reference 字段过滤 / 排序，期号页无法反查本期文章。详见 [03-content-model.md](./03-content-model.md)。
3. **Podcast 扩展 `articles` 集合**（`article_type` 加 `podcast` + `audio_*` / `video_*` / `trending_rank`），不新建集合。
4. **中文搜索需要 trigram**：见 §8。
5. **归档分页用 `?page=`**：未引入 `/page/[n]` 路由，减少路由数。
6. **报头日期为动态**：`Masthead` 用 `Intl`（`Asia/Shanghai`）渲染当天日期，不依赖内容。
7. **Logo 不照搬设计稿**：pulse-news 的图形标改为呼应站名的**脉冲波形**（内联 SVG），不复制设计稿的枫叶。
8. **作者卡不再是米黄卡片**：设计稿里主视觉右下角是「大圆头像 + 大字号 + 米黄底卡片」，实际排下来占一整个板块而信息量很低。改为单行署名（28px 头像 + 姓名 + `·` 角色 + `·` 日期），首页主视觉与文章页一致，外层容器不再有底色 / 内边距。
9. **列表卡无主图时不留占位框**：`MiniCard` 原为对齐同排标题渲染一个同尺寸空边框，视觉上像「图挂了」。改为无图就不渲染媒体区；同排的**作者 / 日期行**仍靠 `margin-top: auto` 对齐。
10. **动效只用 `motion/mini` 而非完整版**：方案原本按完整版 `motion`（`inView` / `stagger` / `press`）设计，实测每个页面公共 chunk 要多付 **21.4KB gzip**。降级为 mini 后，滚动进场改用原生 `IntersectionObserver`、错峰改用 `delay: (i) => i * step`，按压与卡片 hover 抬升改由 CSS 表达（`data-press` / `data-hover-lift`，用独立的 `scale` / `translate` 属性避免与 `transform` 打架），共享 chunk 降到 **3.2KB gzip**。
11. **灯箱不接卡片图**：卡片图外层是 `<a href="/articles/…">`，接灯箱会与跳转冲突。只接图集、文章 hero、期号封面这三类「独立的图」。
12. **动效的位移改用完整 `transform` 写法**：`motion/mini` 不把 `y` / `x` 映射成 `transform`，而是把 keyframe 名直接交给 WAAPI —— 实测 `y` 无任何效果（`getComputedStyle().transform` 恒为 `none`），只在内联 `style` 上留一条无效的 `y: 0px`。改为 `transform: ["translateY(…)","translateY(0px)"]` 后滚动进场与下拉菜单才真正有位移（见 15.3 第 4 条）。
13. **导航子菜单挂在主题自己的菜单上**：`primary` 是通用兜底，两套主题分别读 `theme.config.ts` 里的 `menuName`（`news-factory` / `pulse-news`），所以子菜单 `children` 必须写在对应主题的菜单里，否则前台永远不渲染（见 `AGENTS.md`）。
14. **motion 运行时改为延迟加载**：原先入口 `index.ts` 静态 import `motion/mini`，每个页面都要先下完 ≈5.2KB 才跑动效。拆成 `boot.ts`（无 motion，两道门 + idle/交互触发）+ `runtime.ts`（含 motion，只被动态 import）+ `reduced-motion.ts`（无 motion 的共享状态）后，首屏 eager JS 降到 ≈1.5KB，含引擎的 `runtime.*` chunk 只在真有动效目标的页面、空闲或首次交互时才请求。
15. **灯箱从 Base 收窄到 4 个页面模板**：`<Lightbox />` 原挂在两套 `Base.astro`，每个页面（含订阅 / 归档 / 静态页）都要为它下一段脚本，而触发器只出现在文章页与期号页。改为这两类页面各自渲染，其余页面 `suda-lightbox` 计数为 0。
16. **灯箱上一张 / 下一张淡入改 CSS keyframes**：原用 `animate(imageEl, { opacity })`，为此组件静态 import `motion/mini`。改成 `.lightbox__image--swap` + `@keyframes lightbox-fade-in`（`classList.remove` → 强制 reflow → `add` 重放）后组件不再依赖 motion，脚本小到被 Astro 内联。开合动画仍由运行时驱动 `figure`，与它是不同元素、不同属性。
17. **滚动进场的首屏判据收紧到 `innerHeight`**：延迟加载意味着运行时初始化时用户可能已滚过一段，原 `innerHeight * 0.9` 会把视口下缘 10% 的元素也藏起来再动画（可见闪烁）。改为「任何已落在视口内的一律跳过」，LCP 保护不退化。
18. **性能脚手架用运行期主题切换而非两套构建**：`themeRoutes()` 让一次 `astro build` 就同时产出两套主题，所以 `scripts/perf.mjs` 只构建一次，切主题靠改 `options` 表的 `plugin:pulse-theme:settings:theme`（`finally` 还原）。路由也不硬编码 slug —— 从 `/sitemap.xml` 索引 → 子 sitemap → 第一条 `<loc>`。
19. **播客 / 视频用外部公开 URL 演示**：seed 填 MDN 的 CC0 样本（`t-rex-roar.mp3` / `flower.mp4` / `friday.mp4`），只改字段值即可换成 R2 / 媒体库地址；热链风险见 [03-content-model.md](./03-content-model.md)。

### 待办

- [x] 分版块 RSS `/sections/[slug]/rss.xml` + 版块页 feed 发现链接。
- [x] 移动端 Lighthouse 实测（`npm run perf`，见 §13）。
- [x] 播客 / 视频真实媒体接入（seed 填外部公开 URL；`EpisodePlayer` 渲染原生 `<audio>` / `<video>`）。**待办**：生产换成 R2 / 媒体库地址。
