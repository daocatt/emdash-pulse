/**
 * 期号取数：最新一期 + 该期文章。
 *
 * 两套主题首页都要「本期精选」区块，取数分两段（先取最新期号，再按 `edition`
 * 术语取该期文章），放在这里供主题复用 —— 主题目录只做页面拼装。
 */

import { getEmDashCollection } from "emdash";
import type { CacheHint } from "emdash";
import type { ArticleEntry, EditionEntry } from "./types";

/** 最新一期期号（按 `published_at` 倒序）。 */
export async function getLatestEdition(): Promise<{
	edition: EditionEntry | null;
	cacheHint?: CacheHint;
}> {
	const { entries, cacheHint } = await getEmDashCollection("editions", {
		orderBy: { published_at: "desc" },
		limit: 1,
	});
	return { edition: entries[0] ?? null, cacheHint };
}

/**
 * 最新一期的文章。
 *
 * `entry.id` 是期号 slug（与 `edition` 术语一致，如 `2026-w42`），可直接作为
 * `where: { edition }` 的值。返回 `cacheHints` 数组，调用方统一 `Astro.cache.set`。
 */
export async function getLatestEditionArticles(limit = 8): Promise<{
	edition: EditionEntry | null;
	entries: ArticleEntry[];
	cacheHints: (CacheHint | undefined)[];
}> {
	const { edition, cacheHint: editionHint } = await getLatestEdition();
	if (!edition) return { edition: null, entries: [], cacheHints: [editionHint] };

	const { entries, cacheHint } = await getEmDashCollection("articles", {
		where: { edition: edition.id },
		orderBy: { published_at: "desc" },
		limit,
	});
	return { edition, entries, cacheHints: [editionHint, cacheHint] };
}
