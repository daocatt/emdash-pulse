/**
 * 站内搜索数据层（主题无关）。
 *
 * EmDash 的全文搜索建在 SQLite FTS5 上，迁到 PostgreSQL 后**完全失效**；
 * 本站改用自建索引（`src/server/search-index.mjs`，`pg_trgm` + GIN trigram），
 * 语义与原先 FTS5 的 `trigram` 分词器一致：按字符子串匹配，适合中文。
 *
 * `/search` 页与头部实时搜索（`SearchBox.astro` → `/api/search`）共用同一实现，
 * 因此结果排序 / 片段高亮在两处保持一致。
 */

import { ensureAndRefreshIndex, searchContent } from "../server/search-index.mjs";

export interface SearchHit {
	collection: string;
	id: string;
	slug: string | null;
	title: string;
	/** 已转义并带 `<mark>` 的 HTML 片段（页面用 `set:html` 渲染）。 */
	snippet: string;
}

/**
 * 搜索已发布内容（`articles` + `pages`）。
 *
 * 首次调用会同步建立 / 重建索引（保证第一次就有结果），之后按 5 分钟节流后台刷新。
 * 索引不可用（PG 不可达等）时返回空数组，不抛错。
 */
export async function searchSite(query: string, limit = 30): Promise<SearchHit[]> {
	if (!query.trim()) return [];
	await ensureAndRefreshIndex();
	return (await searchContent(query, limit)) as SearchHit[];
}
