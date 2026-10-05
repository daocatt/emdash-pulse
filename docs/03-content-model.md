# 03 · 内容模型（Schema / Seed）

内容模型定义在 `seed/seed.json`，首次请求时自动应用到空数据库。

---

## 1. Collections 总览

| slug | 标签 | 用途 | 关键 supports |
| --- | --- | --- | --- |
| `articles` | 文章 | 新闻稿件（含**图片新闻**） | drafts, revisions, preview, scheduling, search, seo |
| `pages` | 页面 | 关于/联系/版权/采编规范 | drafts, revisions, search, seo |
| `editions` | 期号 | 显式"第 N 期 / 周报" | drafts, revisions, seo |
| `assignments` | 选题任务 | 编辑 → author agent 的选题分发 | drafts, revisions |

- **署名**：用 EmDash 内置 **bylines**（含 agent 作者，如 Muse / Dots）。
- **Agent 身份**：`user 账号 + byline + scoped token`（见 [09-agent-newsroom.md](./09-agent-newsroom.md)），不单建 collection。
- **订阅者**：由 `bulletin` 插件管理。
- **评论**：EmDash 内置评论表。

---

## 2. `articles` 字段定义

| slug | label | type | required | searchable | 说明 |
| --- | --- | --- | :---: | :---: | --- |
| `title` | 标题 | string | ✅ | ✅ | 主标题 |
| `deck` | 导语 | text | | ✅ | 引题/副题 |
| `content` | 正文 | portableText | ✅ | ✅ | 富文本 |
| `article_type` | 稿件类型 | select | ✅ | | `standard` / `photo` / `live` / `video` |
| `featured_image` | 主图 | image | | | 对象类型 |
| `image_caption` | 图片说明 | string | | | 图注 |
| `photo_credit` | 摄影署名 | string | | | 图片版权/摄影 |
| `gallery` | 图集 | repeater | | | 图片新闻：image + caption + credit |
| `excerpt` | 摘要 | text | | ✅ | 列表/RSS/SEO |
| `review_status` | 审核状态 | select | ✅ | | draft/pending_review/approved/rejected |
| `review_note` | 审核意见 | text | | | 驳回理由 |
| `source` | 来源 | string | | ✅ | 通讯社/本站 |
| `source_url` | 原文链接 | url | | | 幂等去重 |
| `is_breaking` | 突发 | boolean | | | 头版角标 |
| `is_featured` | 头条候选 | boolean | | | 头版头条 |
| `priority` | 版面权重 | select | | | lead/high/normal |
| `assignment` | 关联选题 | reference | | | → `assignments`（agent 投稿溯源） |
| `author_agent` | 作者 agent | string | | | 如 `muse` / `dots`（审计用） |
| `allow_comments` | 允许评论 | boolean | | | 覆盖集合默认 |
| `correction` | 更正说明 | text | | | 已发布勘误 |

### select 选项
```json
"article_type":  { "options": ["standard", "photo", "live", "video"] }
"review_status": { "options": ["draft", "pending_review", "approved", "rejected"] }
"priority":      { "options": ["lead", "high", "normal"] }
```

### 集合定义（seed 片段）
```json
{
  "slug": "articles",
  "label": "文章",
  "labelSingular": "文章",
  "urlPattern": "/articles/{slug}",
  "supports": ["drafts", "revisions", "preview", "scheduling", "search", "seo"],
  "commentsEnabled": true,
  "fields": [
    { "slug": "title", "label": "标题", "type": "string", "required": true, "searchable": true },
    { "slug": "deck", "label": "导语", "type": "text", "searchable": true },
    { "slug": "content", "label": "正文", "type": "portableText", "required": true, "searchable": true },
    { "slug": "article_type", "label": "稿件类型", "type": "select", "required": true, "options": ["standard","photo","live","video"] },
    { "slug": "featured_image", "label": "主图", "type": "image" },
    { "slug": "image_caption", "label": "图片说明", "type": "string" },
    { "slug": "photo_credit", "label": "摄影署名", "type": "string" },
    {
      "slug": "gallery", "label": "图集", "type": "repeater",
      "validation": { "subFields": [
        { "slug": "image", "label": "图片", "type": "image", "required": true },
        { "slug": "caption", "label": "说明", "type": "string" },
        { "slug": "credit", "label": "署名", "type": "string" }
      ] }
    },
    { "slug": "excerpt", "label": "摘要", "type": "text", "searchable": true },
    { "slug": "review_status", "label": "审核状态", "type": "select", "required": true, "options": ["draft","pending_review","approved","rejected"] },
    { "slug": "review_note", "label": "审核意见", "type": "text" },
    { "slug": "source", "label": "来源", "type": "string", "searchable": true },
    { "slug": "source_url", "label": "原文链接", "type": "url" },
    { "slug": "is_breaking", "label": "突发", "type": "boolean" },
    { "slug": "is_featured", "label": "头条候选", "type": "boolean" },
    { "slug": "priority", "label": "版面权重", "type": "select", "options": ["lead","high","normal"] },
    { "slug": "author_agent", "label": "作者 Agent", "type": "string" },
    { "slug": "allow_comments", "label": "允许评论", "type": "boolean" },
    { "slug": "correction", "label": "更正说明", "type": "text" }
  ]
}
```

> `select` 选项键名（`options` / `choices`）与 `repeater.validation.subFields` 以实际 schema 为准，实施时用 `npx emdash schema get articles` 校验。

---

## 3. `editions`（期号，已确认）

| slug | type | required | 说明 |
| --- | --- | :---: | --- |
| `title` | string | ✅ | 如"第 128 期 / 2026 年第 40 周" |
| `period_type` | select | ✅ | `month` / `week` |
| `year` | integer | ✅ | 2026 |
| `period_no` | integer | ✅ | 月 1–12；周 ISO 1–53 |
| `cover_image` | image | | 期号封面 |
| `summary` | text | | 本期导读 |
| `published_at` | datetime | | 出刊时间 |

```json
{
  "slug": "editions", "label": "期号", "labelSingular": "期号",
  "urlPattern": "/editions/{slug}",
  "supports": ["drafts", "revisions", "seo"],
  "fields": [
    { "slug": "title", "label": "期号标题", "type": "string", "required": true, "searchable": true },
    { "slug": "period_type", "label": "周期", "type": "select", "required": true, "options": ["month","week"] },
    { "slug": "year", "label": "年", "type": "integer", "required": true },
    { "slug": "period_no", "label": "期序", "type": "integer", "required": true },
    { "slug": "cover_image", "label": "封面", "type": "image" },
    { "slug": "summary", "label": "本期导读", "type": "text", "searchable": true }
  ]
}
```

前台 `/editions/[slug]` 展示一期版面；文章通过 **taxonomy `edition`** 归入期号（**不是 reference 字段**，原因见下）。

> **变更（Phase 2）**：原设计用 `edition` **reference 字段**关联期号。实测 EmDash **不支持按 reference 字段过滤/排序**（`getEmDashCollection({ where: { edition } })` 返回错误："it is a reference field bound to a relation, and its links are not stored on the entry"），因此期号页无法反查本期文章。改用 **taxonomy `edition`**（术语 = 期号 slug）：可按 `where: { edition: "2026-w40" }` 过滤、有计数、后台选择器友好。`editions` collection 仍保留，用于承载期号自身元数据（标题/封面/导读）与 `/editions/[slug]` 页面。二者通过 **slug 约定**关联（`editions.slug === edition 术语 slug`）。
>
> 同一限制也适用于 `assignment` reference 字段（同样不可过滤）；选题反查文章留待 Phase 4 用 `pulse-editorial` 的专用查询解决。

> **已确认：周报优先**（`period_type=week`，`period_no` 为 ISO 周号）。月报在后续迭代扩展。

---

## 4. `assignments`（选题任务，D16 已确认）

编辑向 author agent 分发选题，agent 领取并投稿。载体为 **EmDash collection**（后台可视化编辑 + API 双通道）。

| slug | type | required | 说明 |
| --- | --- | :---: | --- |
| `title` | string | ✅ | 选题标题 |
| `brief` | text | ✅ | 任务说明/角度/要点 |
| `section` | string | | 目标版块 slug |
| `tags` | string | | 建议标签（逗号分隔） |
| `assigned_agent` | string | | 指定 author agent（如 `muse`），空=公开征集 |
| `deadline` | datetime | | 截止时间 |
| `task_status` | select | ✅ | `open` / `claimed` / `submitted` / `done` / `cancelled`（**注意**：`status` 是 EmDash 保留字段名，故用 `task_status`） |
| `priority` | select | | low/normal/high |
| `claimed_by` | string | | 领取的 agent |
| `claimed_at` | datetime | | |
| `submitted_article` | reference | | → articles |
| `created_by` | string | | 编辑/editor agent |

> **已确认**：用 EmDash collection 承载（非插件 storage），编辑可在后台直接管理。
> **周报优先**：本期先做 `period_type=week`，月报后续扩展。

---

## 5. `pages` 字段

| slug | type | 说明 |
| --- | --- | --- |
| `title` | string | 页面标题 |
| `content` | portableText | 正文 |

用于 `/pages/about`、`/pages/contact`、`/pages/ethics`（采编规范）、`/pages/agents`（agent 接入说明）。

---

## 6. Taxonomies

| name | label | hierarchical | collections | 用途 |
| --- | --- | :---: | --- | --- |
| `section` | 版块 | ✅ | articles | 要闻/国际/财经/科技/文化/体育/社会/评论 |
| `tag` | 标签 | ❌ | articles | 自由关键词 |
| `edition` | 期号 | ❌ | articles | 期号归属（术语 slug 与 `editions` collection 一致） |
| `region` | 地区（可选） | ❌ | articles | 本地新闻分区 |

```json
{
  "name": "section", "label": "版块", "labelSingular": "版块",
  "hierarchical": true, "collections": ["articles"],
  "terms": [
    { "slug": "top", "label": "要闻" },
    { "slug": "world", "label": "国际" },
    { "slug": "business", "label": "财经" },
    { "slug": "tech", "label": "科技" },
    { "slug": "culture", "label": "文化" },
    { "slug": "sports", "label": "体育" },
    { "slug": "society", "label": "社会" },
    { "slug": "opinion", "label": "评论" }
  ]
}
```
> 查询名称必须与 `name` 完全一致。

---

## 7. Menus

| name | items |
| --- | --- |
| `primary` | 首页 `/`、要闻 `/sections/top`、国际 `/sections/world`、财经 `/sections/business`、科技 `/sections/tech`、图片 `/sections/photo`、归档 `/archive`、订阅 `/subscribe` |
| `footer` | 关于 `/pages/about`、采编规范 `/pages/ethics`、Agent 接入 `/pages/agents`、RSS `/rss.xml`、联系 `/pages/contact` |

## 8. Widget Areas

| name | 位置 | 组件 |
| --- | --- | --- |
| `front-sidebar` | 头版侧栏 | `core:search`、`core:categories`、`core:tags`、`core:archives`(monthly)、`core:recent-posts` |
| `article-aside` | 文章页侧栏 | `core:recent-posts`、`core:categories`、订阅 CTA |

## 9. Sections（可复用块）

- `newsletter-signup`、`correction-notice`、`pull-quote`、`photo-gallery-inline`（图片新闻内嵌图集）。

## 10. Bylines（含 Agent 作者）

```json
[
  { "id": "byline-editorial", "slug": "editorial-desk", "displayName": "Suda Pulse 编辑部" },
  { "id": "byline-muse", "slug": "muse", "displayName": "Muse", "bio": "AI 新闻作者" },
  { "id": "byline-dots", "slug": "dots", "displayName": "Dots", "bio": "AI 新闻作者" },
  { "id": "byline-wire", "slug": "wire", "displayName": "综合报道", "isGuest": true }
]
```

## 11. Settings

```json
"settings": {
  "title": "Suda Pulse",
  "tagline": "AI 时代的新闻脉搏",
  "timezone": "Asia/Shanghai"
}
```

---

## 12. Seed 内容示例

### 标准文章
```json
{
  "id": "article-1", "slug": "suda-pulse-launch", "status": "published",
  "data": {
    "title": "Suda Pulse 正式上线",
    "deck": "一个由 Agent 协作生产的新闻系统",
    "article_type": "standard",
    "excerpt": "今天我们发布 Suda Pulse……",
    "review_status": "approved", "priority": "lead", "is_featured": true,
    "author_agent": "muse",
    "content": [{ "_type": "block", "style": "normal", "children": [{ "_type": "span", "text": "正文段落。" }] }]
  },
  "bylines": [{ "byline": "byline-muse" }],
  "taxonomies": { "section": ["top"], "tag": ["发布", "产品"] }
}
```

### 图片新闻（含图集）
```json
{
  "id": "article-photo-1", "slug": "city-night", "status": "published",
  "data": {
    "title": "城市夜景",
    "article_type": "photo",
    "photo_credit": "Suda Pulse 视觉组",
    "featured_image": { "$media": { "url": "https://images.unsplash.com/photo-xxx?w=1600", "alt": "城市夜景", "filename": "night.jpg" } },
    "gallery": [
      { "image": { "$media": { "url": "https://images.unsplash.com/photo-a?w=1600", "alt": "夜景 1", "filename": "n1.jpg" } }, "caption": "夜色下的天际线", "credit": "视觉组" },
      { "image": { "$media": { "url": "https://images.unsplash.com/photo-b?w=1600", "alt": "夜景 2", "filename": "n2.jpg" } }, "caption": "街角灯火", "credit": "视觉组" }
    ],
    "review_status": "approved",
    "content": [{ "_type": "block", "style": "normal", "children": [{ "_type": "span", "text": "图片说明。" }] }]
  },
  "taxonomies": { "section": ["photo"] }
}
```

---

## 13. 审核状态机

```
        ┌──────────────┐  提交审核   ┌────────────────┐
        │    draft     │──────────▶│ pending_review │
        └──────────────┘           └───────┬────────┘
              ▲                            │
      驳回/退回 │                通过        │   驳回
              │                            ▼         │
        ┌─────┴──────┐             ┌──────────┐     │
        │  rejected  │◀────────────│ approved │◀────┘
        └────────────┘             └────┬─────┘
                                        │ 发布 / 定时发布
                                        ▼
                                  published（EmDash status）
```

- `review_status` 是自定义编审字段；`status` 是 EmDash 发布状态。
- 只有 `review_status === "approved"` 允许 `publish()`，由 `pulse-review` 的 `content:beforePublish` 强制（人类 Author 与 Agent 一律适用）。

---

## 14. 迁移与变更注意

- 新增 required 字段前先回填已有数据。
- 不改 taxonomy `name`（破坏性）。
- `npx emdash export-seed --with-content` 备份；`npx emdash schema get <slug>` 校验。

### 保留字段名（不可用作 field slug）

`id` / `slug` / `status` / `author_id` / `primary_byline_id` / `created_at` / `updated_at` / `published_at` / `scheduled_at` / `deleted_at` / `version` / `live_revision_id` / `draft_revision_id` / `terms` / `bylines` / `byline`。
（来源：`emdash/src/schema/types.ts` 的 `RESERVED_FIELD_SLUGS`。）保留集合名：`content` / `media` / `users` / `revisions` / `taxonomies` / `options` / `audit_logs` / `reorder` / `relations`。

### seed 与本地媒体

- `$media` 引用在 `npx emdash seed` 时经 **SSRF 校验**（Cloudflare DoH `cloudflare-dns.com`）后下载。受限网络下该域名不可达会导致下载失败、图片字段留空（schema/内容仍会成功导入）。
- 本地兜底：`node scripts/seed-local-media.mjs`（dev server 需运行）——用普通 fetch 下载图片、经媒体 API 落盘、再写回文章字段并发布。详见 `10-phase0-report.md`。
- **PUT 内容只写 draft revision**；已发布文章需再 `POST /publish` 才会让字段生效到 live（受 `pulse-review` 门禁约束）。
