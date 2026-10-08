# Suda Pulse

基于 **EmDash CMS + Astro** 构建的 Agent 协作新闻/报刊发布系统。
站点：Suda Pulse · `pulse.suda.im` · 时区 `Asia/Shanghai` · 部署 Cloudflare（D1 + R2 + Workers AI）。

规划与任务文档见 `docs/`（先读 `docs/README.md`）。

## Commands

```bash
npm run dev                       # 构建插件 + 启动 Astro dev（SQLite data.db + ./uploads）
SITE_THEME=pulse-news npm run dev # 改构建期默认主题（默认 news-factory；后台可运行期切换）
npm run build:news-factory        # 构建 news-factory 主题（= plugin:build + SITE_THEME=... astro build）
npm run build:pulse-news          # 构建 pulse-news 主题
npm run typecheck:all             # 两套默认主题各跑一次 astro check
npm run perf                      # 移动端性能复核（Lighthouse：构建 + 两套主题 × 代表路由，超阈值退出码 1）
npm run perf -- --no-build --runs=3 --theme=pulse-news   # 复用产物 / 取中位数 / 只测一套主题
npm run plugin:build              # 构建全部插件（--workspaces：pulse-ai/pulse-review/pulse-agent/pulse-editorial/pulse-subscriptions/pulse-seo/pulse-theme/pulse-editor-applications）
npm run plugin:test               # 全部插件单测
node scripts/configure-search.mjs # 中文搜索：切 trigram 分词器并重建索引（重建库后需重跑）
npm run demo:data                 # Demo 互动数据：先清后灌（评论 + 订阅者 + 分组 + 事件）
npm run demo:data:clean           # 只清理 Demo 互动数据
npm run demo:data:remote          # 对远端 D1 执行（先清后灌；需 .env.deploy）
npx emdash types                  # 从运行中的站点生成类型
npx emdash secret                 # 生成加密密钥
npm run deploy:cf                 # 构建并部署到 Cloudflare（账号目录来自本地 .env.deploy）
```

**部署（Cloudflare）**：`npm run deploy:cf` 读取本地 `.env.deploy`（gitignored，模板见 `.env.deploy.example`）里的 `WRANGLER_HOME`，用该目录下已登录的 wrangler 凭据构建 + 部署。**仓库里不出现任何账号信息**（account id 在 gitignored 的 `wrangler.prod.jsonc`，模板见 `wrangler.prod.jsonc.example`）。首次部署后需在后台走一次 setup 向导（灌 seed 内容 + 注册管理员 passkey），并在「Resend」页填 API key / From。

后台：`http://localhost:4321/_emdash/admin`

## 前台主题

两套前台主题都在仓库里。**构建期默认值**由 `SITE_THEME` 决定（默认 `news-factory`），**运行期**可在后台「前台主题」页切换（立即全站生效，无需重新部署）。任一时刻只渲染一套：

| 主题 | 设计来源 | 目录 |
| --- | --- | --- |
| `news-factory` | 报纸头版（深红 + 细横线 + 三栏） | `src/themes/news-factory/` |
| `pulse-news` | 杂志式（米白纸色 + 大留白 + 作者卡） | `src/themes/pulse-news/` |

- 主题页面**不是** `src/pages/` 下的文件路由，而是 `astro.config.mjs` 里 `THEME_ROUTES` + `themeRoutes()` 用 `injectRoute()` 注入的。**默认主题**注册在干净路径上，**另一套**注册在 `/_t/<theme>/…`；`src/middleware.ts` 按运行期设置把干净路径 rewrite 到前缀。**新增人类页面必须同时**：① 在 `THEME_ROUTES` 注册；② 两套主题各放一份同路径文件（缺文件会在 `astro:config:setup` 直接抛错）。
- `src/pages/` 只保留主题无关的机器端点（`rss.xml` / `feed.json` / `llms.txt` / `robots.txt` / `sitemap*.xml` / `agent/**` / `spike/**`）。
- 跨目录引用共享层用别名：`@shared/*` → `src/components/`，`@utils/*` → `src/utils/`（Vite alias 在 `astro.config.mjs`，TS paths 在 `tsconfig.json`，两处必须同步）。
- 主题自述在 `src/themes/<name>/theme.config.ts`（`defineTheme()`，声明 `data-site-theme` 标识与 EmDash 菜单名）。
- 主题目录只放「布局 + 视觉组件 + 页面拼装」；查询 / SEO / 缓存 / 媒体解析 / 日期区间一律进 `src/utils/`，保持主题无关。
- **UI 文案走 i18n 字典**（`src/i18n/`）：`zh-CN.ts` 是键的源头（`MessageKey = keyof typeof zhCN`），`en.ts` 是 `Record<MessageKey, string>`（漏键即编译失败）。页面用 `getTranslations(Astro)` 取 `t()`；**内容不翻译**（不打开 Astro i18n，否则 EmDash 会按 locale 过滤内容查询）。菜单标签用 `menuLabel(url, fallback, t)` 字典驱动。

## Key Files

| File | Purpose |
| --- | --- |
| `astro.config.mjs` | emdash() 集成、数据库、存储、插件注册、**主题路由注入 + 默认主题** |
| `src/middleware.ts` | **运行期主题切换**：读插件设置，把干净路径 rewrite 到 `/_t/<theme>/…`（详见文件头注释） |
| `src/themes/<theme>/` | 前台主题（`theme.config.ts` / `layout/` / `components/` / `pages/`） |
| `src/components/` | 主题无关共享组件（`@shared`） |
| `src/utils/` | 主题无关数据层（`@utils`） |
| `scripts/perf.mjs` | 移动端性能复核（Lighthouse + 运行期主题切换，`npm run perf`） |
| `scripts/deploy-cf.mjs` | 账户无关部署（读 `.env.deploy` → 建 R2 桶 / 写密钥 / 构建 / `wrangler deploy`，`npm run deploy:cf`） |
| `scripts/demo-data.mjs` | Demo 互动数据注入 / 清理（本地 `data.db` 或远端 D1，`npm run demo:data`） |
| `scripts/lib/cf.mjs` | 部署上下文（`.env.deploy` / `wrangler.prod.jsonc` 解析），上面两个脚本共用 |
| `src/live.config.ts` | EmDash loader 注册（样板，勿改） |
| `src/worker.ts` | Cloudflare Worker 入口 + scheduled |
| `wrangler.jsonc` | D1 / R2 / Workers AI 绑定 + cron（**提交**，无账号信息） |
| `wrangler.prod.jsonc` | 生产绑定（含 account_id / database_id，**gitignored**，模板见 `.example`） |
| `.env.deploy` | 本地部署配置（`WRANGLER_HOME`，**gitignored**，模板见 `.example`） |
| `seed/seed.json` | Schema + 示例内容 |
| `plugins/pulse-review/` | 标准格式插件：发布门禁（`content:beforePublish`）+ 评论审核（规则 + AI） |
| `plugins/pulse-ai/` | 标准格式插件：AI 接入层（provider / AI Gateway 配置 + `pulse-ai/client` 库，供同进程复用） |
| `plugins/pulse-editorial/` | 标准格式插件：编辑台（选题分发 + 投稿审核发布，持有 `content:publish`） |
| `plugins/pulse-agent/` | 标准格式插件：Agent 侧（注册/审批、选题领取、投稿、订阅意向） |
| `plugins/pulse-subscriptions/` | 标准格式插件：订阅者 / 分组 / 事件日志 + 确认退订邮件 |
| `plugins/pulse-theme/` | 标准格式插件：后台「前台主题」页（写插件设置，供 `src/middleware.ts` 读） |
| `plugins/pulse-seo/` | 标准格式插件：文章页 JSON-LD / sitemap / robots |
| `emdash-env.d.ts` | 生成的集合类型（dev 启动时自动更新） |

## Rules

- **Cloudflare 部署与远端操作一律走 `npm run deploy:cf` / `npm run demo:data:remote`**：账号目录由本地 `.env.deploy`（gitignored，模板 `.env.deploy.example`）的 `WRANGLER_HOME` 指定，脚本把它作为子进程 `HOME` 传给 wrangler。**仓库里不出现任何账号信息**（账号目录名、account id、token 都不进 git）——写提交的代码 / 文档时别把它们写死。
- 所有内容页面服务端渲染（`output: "server"`）。CMS 内容**不要**用 `getStaticPaths()`。
- **主题是运行期值**：默认主题注册在干净路径上，另一套在 `/_t/<theme>/…`，由 `src/middleware.ts` 用 `next(payload)` rewrite（**不能**用 `context.rewrite()`，它会重跑整条中间件链）。因此主题页面里取路径**一律用 `Astro.originPathname`**，不要用 `Astro.url.pathname`（会带上 `/_t/<theme>` 前缀，污染 canonical / JSON-LD / `isHome` / 导航高亮 / 语言切换链接）；`Astro.url.origin` 与 `Astro.url.searchParams` 不受影响。rewrite **不保留查询串**，中间件已显式拼上。
- **前台客户端动效运行时放 `src/scripts/motion/`**（唯一导入者是 `src/components/MotionRuntime.astro`，用相对导入，不设别名）。`src/utils/` 只放主题无关数据层、`src/components/` 只放 Astro 共享组件，都不放浏览器 DOM 运行时。动效一律 **data 属性驱动 + document 级委托的单例运行时**（仿 `Lightbox.astro`）：组件里只加 `data-*`（`data-reveal[ data-reveal-stagger]` / `data-motion-disclosure` / `data-motion-panel` / `data-press` / `data-motion-lightbox` / `data-hover-lift`），命令式动画只写在 `src/scripts/motion/` 里。`<MotionRuntime />` 挂在两套 `layout/Base.astro`。
- **motion 运行时是延迟加载的**：`MotionRuntime.astro` 只引 `boot.ts`（**无 motion**）——它先过两道门（① 非 reduced-motion；② 页面里真有 `[data-reveal]` / `details[data-motion-disclosure]` / `[data-motion-lightbox]`），再等 `requestIdleCallback`（回退 `setTimeout`）或用户先交互（`scroll` / `pointerdown` / `keydown`），才 `import("./runtime")`。所以 **`runtime.ts` 只能被 boot 动态 import**，任何静态引用都会把 `motion/mini` 拉回首屏包、延迟加载失效。`reduced-motion.ts` 单独成文件（无 motion）就是为了让 boot 能读状态而不下载引擎。
- **运行时绑定前要有 CSS 兜底**：绑定发生在 `DOMContentLoaded` 之后（实测 ≈ DCL + 50ms，而首帧更早），所以「页面刚打开就点菜单」会走原生 `<details>` 开合、完全没有过渡。做法是组件里写一段本地 keyframes，用 `html:not([data-motion-ready])` 限定 —— `runtime.ts` 的 `run()` 开头会给 `<html>` 打 `data-motion-ready`，绑定后 CSS 规则自动让位给 WAAPI。**两条路径必须互斥**，否则同一条 `opacity` 会被 CSS 动画和 WAAPI 同时驱动（现在只有 `Masthead.astro` 的菜单面板这么做；`MainNav` 的下拉同理，需要时照搬）。
- **`motion/mini` 必须写进 `vite.optimizeDeps.include`**：它只被动态 import 的 `runtime.ts` 引用，不预构建时 Vite 可能在首次动态 import 时才去优化它、重新生成 browserHash → 那一发请求 `504 Outdated Optimize Dep` → `boot.ts` 只打一条 warn，**整条动效运行时静默失效**（下拉 / 滚动进场 / 灯箱全无动画，页面看起来「没写动效」）。症状排查：控制台有 `[motion] load failed`，`details[data-motion-disclosure]` 上没有 `data-motion-bound`。**救急：停 dev server → `rm -rf node_modules/.vite` → 重启**。
- **灯箱与动效用 DOM 事件解耦**：`Lightbox.astro` 只加 `data-motion-lightbox` 并负责状态/导航，开合动画在 `src/scripts/motion/lightbox.ts`。打开后组件派发 `lightbox:open`；关闭前派发**可取消**的 `lightbox:close-request`，运行时 `preventDefault()` 接管、播完退场再 `dialog.close()`。没有接管者（无 JS / 减动效 / **runtime 还没加载**）时组件自行 `close()` —— 新增灯箱交互时务必保留「`dispatchEvent` 返回 true 就原生 close」的兜底。上一张/下一张的淡入用**本地 CSS keyframes**（组件不依赖 motion）。
- **灯箱只挂在使用它的页面**：`<Lightbox />` 不放在 `Base.astro`，而是两套主题的 `pages/articles/[slug].astro` 与 `pages/editions/[slug].astro` 各自渲染（共 4 个模板）。判据是 `data-lightbox` 触发器的分布（`Gallery.astro` + 文章 hero + 期号封面）。**新增带图页面若要灯箱，必须自己挂**；漏挂则触发器点了没反应。验证：`curl` 4 类路由有 `suda-lightbox`、其余为 0。
- **动效强度是主题令牌**：`--motion-duration-*` / `--motion-ease` / `--motion-shift-*` / `--motion-stagger` / `--motion-hover-lift` 在 `src/styles/tokens.base.css` 给默认值，两套主题在各自 `styles/tokens.css` 覆盖（news-factory 克制 / pulse-news 明显）。**JS 不判断主题名**，一律 `getComputedStyle` 读令牌。
- **滚动进场的隐藏态只能由 JS 加**：SSR HTML / CSS 里**不能**出现初始隐藏样式（`Astro.cache` 会缓存 HTML，且无 JS 时内容必须可见）。`data-reveal` 元素里，**任何已落在视口内**的（`rect.top < innerHeight`）一律跳过不进场 —— 既保护 LCP，也因为运行时是延迟加载的（初始化时用户可能已滚动，把视口下缘那 10% 也算进去会「闪一下再动画」）。
- **`motion` 只从 `motion/mini` 引入**（只有 `animate` / `animateSequence`，WAAPI 版）。完整版 `motion` 会把动画引擎打进每个页面的公共 chunk（实测 ≈21KB gzip），mini 是个位数 KB。mini 没有 `inView` / `stagger` / `press` / `MotionGlobalConfig`，对应替代：滚动进场用原生 `IntersectionObserver`、错峰用 `delay: (i) => i * step`、按压与 hover 抬升留在 CSS。`ease` 直接给 CSS 形式（`cubic-bezier(...)` 或关键字），因为 WAAPI 就吃这个。改完必须量 `dist/client/_astro` 的体积：**首屏 eager JS（boot + preload helper）≈1.5KB gzip；含 motion 的 `runtime.*` chunk ≈4.2KB gzip，预算 ≤ 12KB**。
- **mini 的 keyframe 名必须是真实 CSS 属性**：`animate()` 不做 `y` / `x` → `transform` 的映射，它把 keyframe 的属性名**直接**交给 WAAPI。所以 `y` / `x` / `rotate` 这类完整版 shorthand 会被**静默忽略**（只在内联 `style` 里留一条无效的 `y: 0px`），必须写 `transform: ["translateY(6px)", "translateY(0px)"]`；`opacity` / `height` / `scale` / `translate` 是真实属性，可直接用。判断某个 keyframe 有没有生效，看动画中途的 `getComputedStyle(el).transform`，别只看 `element.style`（WAAPI 不写内联样式）。
- **`prefers-reduced-motion` 要管两遍**：`src/styles/base.css` 的全局兜底只管 CSS transition/animation；`animate()` 是 JS/WAAPI 驱动，管不到 —— 每个 init 开头必须用 `matchMedia` 早退（reduced-motion 下不设隐藏态），CSS 侧的 `data-hover-lift` / `data-press` 位移也要在同一个媒体查询里显式关掉。
- **一条属性只能有一个驱动源**：被 `motion` 用内联 `transform` 驱动的元素，不得同时有 CSS `:hover { transform }` / `transition: transform`。卡片 hover 抬升（`data-hover-lift`）与按压反馈（`data-press`，规则都在 `src/styles/base.css`）刻意用 `translate` / `scale` 这两个**独立属性**而非 `transform` —— 与 `transform` 叠加而非覆盖；滚动进场结束时也会清除内联 `transform` 归还给 CSS。
- 图片字段是对象（`{ id, meta: { storageKey }, alt, width, height, blurhash, ... }`，落库时**没有 `src`**，见下方规则），用 `emdash/ui` 的 `<Image image={...} />`（自动 `srcset`/`sizes`/宽高/WebP/LQIP；首屏图传 `priority`）。**`astro.config.mjs` 的 `image.remotePatterns` 必须包含站点自身 origin**（本地 `localhost`/`127.0.0.1` + 生产域名）：EmDash 会把同源媒体路径解析成绝对 URL 交给 Astro 的 image service，未授权时**生产构建会静默退回原图**（`srcset` 各档位指向同一张全尺寸图）。生产域名**不写死在源码里** —— `deploy:cf` 会把 `wrangler.prod.jsonc` 的 `vars.EMDASH_SITE_URL` 传给 `astro build`，`astro.config.mjs` 的 `siteOriginPattern()` 据此补上；所以换域名只改部署配置，无需动源码（手动 `astro build` 时记得自己导出 `EMDASH_SITE_URL`）。
- `entry.id` 是 slug（URL 用）；`entry.data.id` 是数据库 ULID（`getEntryTerms`、评论 `contentId` 用）。
- taxonomy 名称必须与 seed 的 `"name"` 完全一致（`section` / `tag` / `edition`）。
- **主题导航读的是 `theme.menuName`，不是 `primary`**：news-factory / pulse-news 各自读同名菜单（`src/themes/<t>/theme.config.ts`），`primary` 只是通用兜底、两套主题都不用它。所以改导航（含子菜单 `children`）必须改**对应主题**的菜单，改 `primary` 前台不会有任何变化。改完 seed 菜单要重跑 `npx emdash seed seed/seed.json`（菜单是「整段删除重建」，能生效），而 `astro dev` 不会自动重跑 seed。
- Astro 路由缓存启用时，把查询返回的 `cacheHint` 传给 `Astro.cache.set()`；用 `*WithCacheHint` 变体。
- 按月/周筛选：`where: { published_at: { gte, lt } }`（ISO 字符串，`lt` 为开区间）。
- **插件改动后必须 `npm run plugin:build`**：`astro.config.mjs` 的 `plugins: []` 按 `descriptor.entrypoint`（如 `pulse-review/sandbox`）导入**已构建的 `dist/*.mjs`**；指向 TS 源码会报错，`exports` 需带 `default` 条件（`require.resolve` 解析）。
- **插件通过 npm workspaces 管理**（根 `package.json` 的 `workspaces: ["plugins/*"]`）：根 `npm install` 会安装插件依赖并链接各插件。**不要**在插件目录单独 `npm install`（会被根安装当作 extraneous 清掉）。
- **插件之间复用代码只能靠「不声明依赖的相对/内联 import」**（`pulse-ai/client` 即此模式）：`emdash-plugin build` 用 rolldown 打包 `src/plugin.ts`，**只把 `emdash/plugin` 与 `zod` 走 `noExternal` 内联**，其余**裸模块名一律判为 external** → 产物被拷到临时目录做 probe 时解析不到 → `Cannot find package 'xxx'` 整包构建失败。所以：① 被复用的库要么零静态依赖（对宿主的引用只能动态 `import(...)`，且用**模板字符串**拼接让 rolldown 不做静态分析），要么被消费方**内联**；② **消费方不要把该 workspace 包写进 `dependencies`** —— 声明了就会变成 external import 而构建失败，不声明才会被内联（实测 pulse-review 的 `plugin.mjs` 5.9KB → 8.7KB）。③ 插件设置按 plugin id 隔离（`ctx.settings` 只能读自己），跨插件读设置只能靠动态 `import("emdash")` 拿 `getPluginSetting`（宿主同一份实例，`getDb()` 的 AsyncLocalStorage 才有效）。
- **沙箱路由收不到 `Authorization` / `Cookie` / `X-EmDash-Request`**（宿主过滤，声明也会被拒）。Agent 凭证改用自定义头（本项目用 `X-Agent-Token`），并在路由 `request.headers` 显式声明。
- **MCP 工具只能挂「私有 + POST + JSON」路由**：GET 路由或未声明 body 的路由无法作为 MCP 工具（构建期报错）。
- **默认 JSON 路由一律 HTTP 200**（宿主包 `{success,data}`）。要真实状态码（如 401/429）需声明 `response: "raw"` 并返回 `pluginResponse({ status, headers, body: { kind: "text", value: JSON.stringify(...) } })`（`emdash/plugin`）。raw 路由**不能**作为 MCP 工具，响应头受白名单限制（`content-type`/`retry-after` 可用）。`pulse-agent` 公开路由即用此约定（400/401/404/409/429）。沙箱测试宿主会回传 `PluginResponse` 信封（`{__emdashPluginResponse,status,body}`），测试需解包。
- 沙箱插件**没有** user/API token/byline 写能力（仅 `users:read`、`ctx.bylines` 只读）；需要建 user/token 只能走 trusted 代码（`UserRepository` 从 `emdash` 导出）。
- **插件存储的 `uniqueIndexes` 是「整表」唯一索引**：声明后宿主建的是 `_plugin_storage(plugin_id, collection, json_extract(data,'$.field'))` 上的唯一索引，**覆盖该表所有行**。所以同一插件里**另一个集合复用同名字段就会互撞**（`pulse-subscriptions` 的 `events` 一度照抄 `subscribers` 的 `emailHash` → 同一订阅者第 2 条事件撞唯一约束 → `recordEvent` 吞异常 → 事件静默丢失）。跨集合复用的字段名要避开被声明为 unique 的字段。
- **内存版测试宿主不校验索引 / 触发器**：唯一索引、字段规范化这类「只在真数据库生效」的约束，单测全绿也测不出来 —— 必须跑一次 `npm run demo:data` 或 dev 才能暴露。
- `ctx.content.list` 的 `where.fieldFilters` **只支持 indexed 字段**；按字段筛选前需在 seed 里给该字段加 `"indexed": true` 并重建库。
- **EmDash 的 `indexed` 生成的单字段索引（`(col IS NOT NULL, col, id) WHERE deleted_at IS NULL`），对「等值过滤 + `ORDER BY published_at`」查询不被 SQLite 优化器选用**（实测 2000 行：仍走 `idx_ec_*_deleted_published_id` 有序扫描；只有复合索引 `(col, published_at)` 才会被选，而 seed 不生成这种）。所以**别把加 `indexed` 当首页性能杠杆** —— 它的价值在后台筛选与 `fieldFilters`；降低 D1 读负载靠缓存，见 [docs/14-database.md](docs/14-database.md)。
- **Workers Cache 已启用**（`astro.config.mjs` 的 `cache: { provider: cacheCloudflare() }` + `routeRules`，**仅 CF 部署注入**）：命中时请求在 Worker 之前就返回，完全不跑 SSR / 不查 D1。内容页靠 `Astro.cache.set(cacheHint)` 与集合 tag 关联（**只有配了 provider 才不是空操作**，发布时 EmDash 按 tag purge）。**新增任何「会话 / token / 动态」页面必须显式设 `Cache-Control: private, no-store`** —— 否则会被 CF 启发式缓存 2 小时；现有清单在 `src/middleware.ts` 的 `NO_STORE_PREFIXES` / `NO_STORE_EXACT`。另注意缓存在 Worker 之前，登录编辑可能拿到匿名缓存版本。见 [docs/14-database.md](docs/14-database.md)。
- **`ctx.content.update` 是 draft-aware**：集合支持 `revisions` 时改的是**草稿修订**，`ctx.content.get`/`list` 读的是**条目行**（要 `publish` 才更新）。审核类流程若只 `update`，队列会读到旧值 → 需用 `content:revisions:read` + `listRevisions` 读最新修订。
- **所有插件都在宿主进程内运行（`plugins: []`，不用 `sandboxed: []`）**：Cloudflare Workers 上唯一的沙箱后端是 Worker Loader（`LOADER` 绑定），需付费计划；免费计划下 `@emdash-cms/cloudflare` 的 `sandbox()` 读不到绑定会返回 `undefined`，沙箱插件会**静默全部不加载**（构建期只打一条 warn）。`sandbox: false` 这个本地逃生舱在 Workers 上被运行时显式禁用（emdash-runtime 抛错）。标准格式插件经 `adaptSandboxEntry` 在宿主进程内适配，`hooks` / `routes` / `storage`（含唯一索引）/ `adminPages` / `mcp.tools` / 能力门禁都保留，代价是失去 isolate 隔离。本地与生产走同一条路径，避免 dev/prod 分叉。
- 调 REST API 时写请求需 `X-EmDash-Request: 1` 头（CSRF）；更新内容用 `PUT`；**PUT 只写 draft revision**，已发布文章需再 `POST /publish` 才生效。
- **`select` 字段的选项必须写在 `validation.options`**，不是字段顶层 `options`：EmDash 只从 `validation.options` 读取（zod 写入校验、后台下拉选项、`emdash types` 生成的字面量联合类型都依赖它，见 `zod-generator.ts` 与 admin 序列化）。写错位置 → 后台下拉空白、校验退化为任意字符串、`emdash-env.d.ts` 退化成 `string`。
- **改 `articles.article_type` 的枚举要三处同步**：seed 的 `validation.options`、`plugins/pulse-agent/src/plugin.ts` 的 `z.enum([...])`（投稿入参校验），然后 `npm run plugin:build`（`plugins: []` 导入的是已构建的 `dist/*.mjs`）。漏改会让 agent 投稿被 zod 拒绝。
- **改 seed 的字段定义不会同步到已建库**：`applySeed` 用 `onConflict: "skip"`，集合已存在时**整段跳过（含字段）**。改字段要么删库重建，要么手动更新 `_emdash_fields`（`validation` 列）。
- **`where` 里的布尔字段必须传原生布尔值**：EmDash 把布尔字段存成 INTEGER（写入 0/1），loader 的 `bindableFilterValue` 会把 `true`/`false` 归一化成 `1`/`0`，所以运行时支持布尔过滤；但公共类型 `WhereValue` 只有 `string | string[] | WhereRange`，直接写 `where: { is_featured: true }` 会 ts(2322)。用 `@utils/query` 的 `whereClause({ is_featured: true })` 收窄。**别传字符串 `"true"`** —— SQLite 拿字符串去比 INTEGER 列，恒不命中。
- **落库的图片字段是「无 `src`」的 `MediaValue`**：seed 的 `$media` 与媒体上传 API 落库后只剩 `{ provider, id, filename, mimeType, width, height, blurhash, dominantColor, alt, meta: { storageKey } }` —— **`src` 会被规范化掉**。公共文件路由 `/_emdash/api/media/file/{key}` **只认 storage key（带扩展名）**，传 `id`（媒体行 ULID）恒 404；`/_emdash/api/media/asset/{id}/{filename}` 那条是按 `id` 查的，但需登录（401），前台不可用。所以 `@utils/media` 的 `resolveMediaUrl` 必须**先看 `meta.storageKey` 再看 `id`**（顺序对齐 EmDash 的 `buildRenderMediaUrl`：storageKey → src → … → id）。漏了 storageKey 分支 → 灯箱大图 / 期号封面 / agent JSON 的 `image.url` 全是 404，而 `<Image>`（走 `meta.storageKey`）照常渲染，所以**只在点开灯箱或看 API 时才暴露**。
- **`@emdash-cms/plugin-audit-log` 0.2.3 需要打补丁**：它的 `/history` 页手写 `table` block 用了 camelCase（`pageActionId` 等），而 `@emdash-cms/blocks@1.1.0` 要求 snake_case → 后台 Audit History 整页 502 `INVALID_BLOCK_RESPONSE`。根 `postinstall` 会自动跑 `scripts/patch-audit-log.mjs`（幂等；上游修复后自动跳过），`npm install` 后无需手动处理。
- **`emdash-plugin-resend` 0.2.0 需要打补丁**：它的 sandbox 入口用 `definePlugin({ hooks, routes })` **不传 `id`**（旧版 `emdash@^0.5.0` 的写法），而 emdash 1.2.0 的 `definePlugin()` 是**原生格式**助手、**要求 `id`** → 模块加载即抛 `definePlugin() requires \`id\``。产物里该入口是**静态导入**，抛错冒泡成**整站 500**（任意路由，Node 与 Workers 都中招）。根 `postinstall` 会自动跑 `scripts/patch-resend.mjs`（去掉包装，让默认导出变成适配器期望的 `{ hooks, routes }`；幂等，`node --check` 兜底，上游修复后自动跳过）。**判据**：in-process 的 `format: "standard"` 插件若其 sandbox 入口调了 `definePlugin()`，就是坏的 —— 沙箱格式应直接 `export default { hooks, routes }`（身份来自 `emdash-plugin.jsonc`）。
- **Block Kit 的「块」与「元素」是两层**：顶层 `blocks[]` 只接受块类型（`header` / `section` / `divider` / `table` / `actions` / `form` / …），`radio` / `select` / `toggle` / `button` / `text_input` 等是**元素**，必须嵌在 `actions.elements`（或 `form.fields` / `section.accessory`）里。把元素直接放进 `blocks[]` → 宿主校验拒绝 → 后台整页 502 `INVALID_BLOCK_RESPONSE`（`validateBlocks` 报 `Unknown block type 'radio'`）。字段名一律 snake_case（`action_id` / `initial_value` / `page_action_id`），用 `@emdash-cms/blocks` 的 builder（`blocks.*` / `elements.*`）则传 camelCase 由 builder 转换。新增后台页务必在测试里跑一遍 `validateBlocks`，或用 `createPluginRuntimeTestHost().admin.loadPage()` 走宿主校验。

## Git

- **Commit messages MUST be written in English** (subject + body), even though the codebase, docs, and comments are in Chinese.
- Use Conventional Commits prefixes: `feat:` / `fix:` / `docs:` / `test:` / `refactor:` / `chore:` / `perf:`. Scope optional, e.g. `feat(pulse-agent): ...`.
- Subject line: imperative mood, lowercase after the colon, no trailing period, ≤ 72 chars.
- Split commits by logical change (one concern per commit); do not bundle unrelated edits.
- Do NOT add `Co-Authored-By` or AI-attribution trailers.

## Skills & Docs

- EmDash skills：`.agents/skills/`（`building-emdash-site`、`creating-plugins`、`emdash-cli`）。
- 文档 MCP：`https://docs.emdashcms.com/mcp`（核对 API/hook/字段时优先用）。
- 项目规划：`docs/`。
