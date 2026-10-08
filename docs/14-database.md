# 数据库选型与查询负载复核

> ⚠️ **本文已被 [16-vps-deployment.md](./16-vps-deployment.md) 取代（2026-10）。**
> 下面的结论建立在「必须保留 EmDash 内置 FTS 中文搜索」这一前提上 —— 而该前提随后被推翻：
> 我们自建了 `pulse_search` 表 + `pg_trgm` GIN trigram 索引（语义与 FTS5 的 trigram 分词器一致），
> 于是运行时整体迁到 **VPS + PostgreSQL + Redis**，不再使用 D1 / Workers Cache。
> 保留本文作为**决策历史**：D1 的配额与索引行为、以及「索引不是杠杆、缓存才是」的判断仍然有效。
> 当前架构见 [16-vps-deployment.md](./16-vps-deployment.md)。

> 结论先行（**历史结论，已作废**）：**继续用 D1，不迁移到 VPS 上的 PostgreSQL。** 真正的负载杠杆不是索引，而是
> **启用 Astro route cache / Workers Cache**（当前未启用，代码里所有 `Astro.cache.set(cacheHint)`
> 都是空操作）。本文记录复核依据与已落地的改动。

---

## 1. 选型结论：为什么不用 Postgres

| 约束 | 证据 |
| --- | --- |
| **换 Postgres 会丢掉中文全文搜索** | EmDash 的 FTS 索引建在 **FTS5 虚拟表**（`_emdash_fts_*`）上，`FTSManager` 在非 SQLite 方言下**直接抛错**（[10-phase0-report.md](./10-phase0-report.md) §Phase 2 发现 4）。本站 `/search` 与报头 `LiveSearch` 依赖 trigram 中文检索（`scripts/configure-search.mjs`），换库即失效 |
| **Postgres 适配器只支持 Node.js 运行时** | 官方适配器表：`sqlite` / `libsql` / `postgres` → Node.js；`d1` / `hyperdrive` / `durableObjects` → Cloudflare Workers。选 `postgres` 意味着**放弃整套 CF 栈**（Workers、R2 媒体、Workers AI 评论审核、cron 定时发布、边缘缓存）——是架构级回退，不是换个 adapter |
| **本项目规模用不上 PG** | 当前 36 篇文章、整库 2.9 MB。新闻站读多写少，SQLite/D1 的单写者从不是瓶颈。PG 的价值（多进程/多实例共享一个库、高并发写）这里用不上 |

**若将来真要自托管 VPS**：选 **Node + SQLite**（不是 Postgres）——既保留 FTS，运维也简单
（单进程 + 持久盘 + WAL）。只有需要「多进程/多实例共享一个库」时才轮到 Postgres。

**中间选项（保留 Workers + VPS Postgres via Hyperdrive）不推荐**：FTS 仍失效、复杂度最高、
需要 Workers 付费计划，且官方注明 **sandboxed plugins 是 D1-only**。

---

## 2. D1 的真实约束（2026-09 起）

D1 免费层（Workers Free）自 **2026-09-01** 起从「软性超限」改为**硬性失败**——一旦超出当日
读/写上限，**当天后续每一个 D1 查询都直接报错**，直到 00:00 UTC 重置：

| 配额（免费层） | 数值 |
| --- | --- |
| 行读取 | 5,000,000 行/天 |
| 行写入 | 100,000 行/天 |
| 存储 | 5 GB |
| 计量口径 | **查询引擎扫描的行数**（不是返回行数、不是请求数） |

Workers Paid（$5/月）把同样的读写计量转为**按百万行计费**：含 25B 读 / 50M 写每月。

> **关键**：因为计量的是「扫描行数」，未加索引的 `WHERE` 全表扫描会迅速吃掉配额。
> 这也是本次复核的起因。

---

## 3. 数据库设计复核

### 3.1 查询模式

首页 `src/themes/news-factory/pages/index.astro:45-90` 一次 SSR 发出 **9+ 个查询**：

| 查询 | 过滤字段 | 排序 |
| --- | --- | --- |
| 最新 12 篇 | — | `published_at desc` |
| 头条（lead） | `priority='lead'` | `published_at desc` |
| 头条候选 | `is_featured=true` | `published_at desc` |
| 视频 / 播客 / 图片 | `article_type=...` ×3 | `published_at desc` |
| 热度榜 | `trending_rank >= 1` | `trending_rank asc` |
| 最新一期文章 | taxonomy `edition` | `published_at desc` |
| 话题 | taxonomy `tag` | `published_at desc` |

其中 `article_type` / `is_featured` / `priority` 三个字段**原先没有索引**。

### 3.2 索引现状与实测

EmDash 对 `"indexed": true` 的字段生成的是**单字段部分索引**：

```sql
CREATE INDEX idx_cf_xxx ON ec_articles (("字段" IS NOT NULL), "字段", id) WHERE deleted_at IS NULL
```

用 2000 行合成数据实测 `WHERE 字段=? ORDER BY published_at DESC LIMIT 5`（`EXPLAIN QUERY PLAN`）：

| 索引形式 | 优化器选择 |
| --- | --- |
| 无自定义索引 | `SEARCH ... USING INDEX idx_ec_articles_deleted_published_id`（有序扫描 + 过滤） |
| **单字段索引** `(字段, id)`（EmDash `indexed` 生成的形式） | **仍选 `idx_pub`——单字段索引不被选用**（用它还要额外 `USE TEMP B-TREE FOR ORDER BY`） |
| **复合索引** `(字段, published_at DESC)` | ✅ `SEARCH ... USING INDEX idx_cf_复合`（定位 + 有序，无需排序） |

**结论**：对「等值过滤 + 按 `published_at` 排序 + LIMIT」这类首页查询，**EmDash 的 `indexed`
机制生成的单字段索引基本不会被 SQLite 优化器选用**，因此它**不是降低 D1 扫描行数的杠杆**。
真正有效的是 `(字段, published_at)` 复合索引，但 EmDash 的 seed 不生成这种形式（手写 SQL 会在
重建库/升级时丢失，不值得）。

> 保留这三个索引的理由：`indexed` 是 EmDash 声明式字段属性，后台 admin 按字段筛选、
> 插件的 `ctx.content.list` `fieldFilters`（**只支持 indexed 字段**）都依赖它；写开销对本站
> 可忽略。但**不要**把它当作首页性能优化。

### 3.3 真正的杠杆：缓存（当前未启用）

`src/themes/**` 与 `src/utils/**` 到处写着 `if (Astro.cache?.enabled) Astro.cache.set(cacheHint)`，
但 **`astro.config.mjs` 里没有任何 `cache` / `experimental` 配置** → `Astro.cache.enabled` 恒为
`false` → **这些调用全部是空操作，每个 PV 都实打实跑满 D1 查询**。

EmDash 提供两级缓存（见官方 deployment/cloudflare）：

| 手段 | 作用 | 命中时的效果 |
| --- | --- | --- |
| **Workers Cache**（`cacheCloudflare()` + `routeRules`） | 在 Worker **前面**做边缘缓存 | 命中时**完全不跑 Worker**，D1 零查询 |
| **Object Cache**（`kvCache({ binding: "CACHE" })`） | 把内容/配置**查询结果**缓存到 KV | 命中时跳过 D1 读 |

启用 Workers Cache 的形态（仅 CF 部署生效）：

```js
// astro.config.mjs
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
export default defineConfig({
  cache: { provider: cacheCloudflare() },
  routeRules: {
    "/": { maxAge: 300, swr: 86400 },
    // 其余公开路由按需给不同寿命
  },
});
```

**两个必须注意的官方警告**：
1. 没有 `Cache-Control` 头的响应会被**启发式缓存 2 小时**——每个自定义路由都要显式给头
   （会话相关的一律 `private, no-store`）。
2. 缓存在 Worker 之前，**无法按 Cookie 绕过**——登录编辑可能拿到匿名缓存版本（不含可视化编辑
   工具栏），直到条目过期。编辑态响应本身带 `private, no-store`，不会反向泄漏。

### 3.4 其他核查项

| 项 | 结论 |
| --- | --- |
| **`editions` 的 `year`/`period_no` 索引** | **不需要**。`getLatestEdition()`（`src/utils/edition.ts:17`）与 `/agent/editions`（`src/pages/agent/editions/index.ts:12`）**全部按 `published_at desc` 排序**，已命中内建 `idx_ec_*_deleted_published_id`；期号详情按 slug 查（有唯一索引）。加索引只增加写开销 |
| **`_emdash_404_log` 写配额** | **不需要改代码**。EmDash 内建上限 **10,000 条**，按「最久未见」自动淘汰（官方 seo 指南）。后台「Redirects → 404 Errors」可 prune/clear，或给高频路径加 301/410 规则 |
| **`revisions` 增长** | 36 篇 → 187 条（约 5×）。EmDash 有 `_emdash_revision_prune_queue` 机制，保持默认即可 |
| **taxonomy 查询** | `content_taxonomies` 有 `idx_content_taxonomies_group_lookup`，正常 |

---

## 4. 已落地改动

1. **`seed/seed.json`**：`articles` 的 `article_type` / `is_featured` / `priority` 加
   `"indexed": true`（结构性正确 + 服务后台/插件按字段筛选；**不是**首页性能杠杆，见 §3.2）。
2. **`astro.config.mjs`**：D1 适配器加 `coalesce: true`（`session: "auto"` 已开）——把首页同
   一事件循环里的并发读合并成更少的 D1 **往返**，降低延迟。注意它**不减少计费扫描行数**。
3. **启用 Workers Cache**：`astro.config.mjs` 加 `cache: { provider: cacheCloudflare() }` + `routeRules`（**仅 CF 部署注入**，Node 部署不引入 CF 包）；`src/middleware.ts` 对会话 / 表单 / 错误页统一设 `Cache-Control: private, no-store`。
4. 新建本文档。

### 4.1 缓存策略

| 路由 | maxAge | swr |
| --- | --- | --- |
| `/`、`/articles/[...path]`、`/sections/[...path]`、`/tags/[...path]`、`/editions/[...path]` | 300 | 86400 |
| `/pages/[...path]`、`/archive`、`/archive/[...path]` | 600 | 86400 |
| `/rss.xml`、`/feed.json` | 300 | 86400 |
| `/llms.txt`、`/robots.txt`、`/sitemap*.xml` | 3600 | 86400 |

**`private, no-store`**（`src/middleware.ts` 的 `NO_STORE_PREFIXES` / `NO_STORE_EXACT`）：`/search`、`/subscribe`、`/subscribe/confirm`、`/subscribe/unsubscribe`、`/editor/apply`、`/404`、`/spike/**`。

**自身控制**：`/agent/**`（`jsonResponse` 已设 `public, max-age=300`）、`/_emdash/**`（EmDash 已 `no-store`）、`/_astro/**`（adapter 注入 immutable）。

> 内容页已调用 `Astro.cache.set(cacheHint)`，响应与集合 tag 关联，发布时由 EmDash purge。

> **改 seed 字段不会同步到已建库**（`applySeed` 用 `onConflict: "skip"`，集合已存在时整段跳过）。
> 本地要生效需删库重建（`rm data.db*` 后重新 seed/dev）；生产 D1 需 `emdash migrate` 或重建。

---

## 5. 后续可选项（按性价比排序）

1. ~~启用 Workers Cache~~ ✅ **已实施**（见 §4 / §4.1）。
2. **可选启用 Object Cache**（`objectCache: kvCache({ binding: "CACHE" })`）：进一步把查询结果缓存到 KV，连 Worker 内的 D1 读都省掉。
3. **减少首页查询数**：9+ 个查询可合并为「一次取 N 篇、内存分类」，减少往返。
4. **升级 Workers Paid（$5/月）**：25B 读 / 50M 写每月，对本站等于无限，成本远低于 VPS + PG 的运维成本。若担心免费层硬限额，这是最省事的保险。
5. **生产上线后用 Cloudflare 控制台 Metrics → Row Metrics** 盯每日读/写量，对照 5M / 100K 阈值。
