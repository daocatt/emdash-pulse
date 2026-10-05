/**
 * 搜索辅助。
 *
 * EmDash 的 FTS 索引在本站配置为 `trigram` 分词器（见 scripts/configure-search.mjs），
 * 它支持中文子串检索，但**要求查询至少 3 个字符**（trigram 的固有下限）。
 * 对 1–2 字的短查询，这里提供一次内存回退扫描（站点规模较小，成本可接受）。
 */

import { getEmDashCollection } from "emdash";
import { extractPlainText } from "./text";

export interface FallbackHit {
	collection: string;
	id: string;
	slug: string | null;
	title: string;
	snippet: string;
}

const MAX_SCAN = 200;

export async function fallbackSearch(query: string, limit = 20): Promise<FallbackHit[]> {
	const needle = query.toLowerCase();
	const hits: FallbackHit[] = [];

	const [articles, pages] = await Promise.all([
		getEmDashCollection("articles", { orderBy: { published_at: "desc" }, limit: MAX_SCAN }),
		getEmDashCollection("pages", { limit: MAX_SCAN }),
	]);

	const consider = (collection: string, id: string, slug: string | null, title: string, body: string, extra = "") => {
		if (hits.length >= limit) return;
		const haystack = `${title}\n${body}\n${extra}`.toLowerCase();
		if (!haystack.includes(needle)) return;
		hits.push({
			collection,
			id,
			slug,
			title,
			snippet: buildSnippet(body, needle),
		});
	};

	const termLabels = (terms?: Record<string, { label: string }[]>) =>
		terms ? Object.values(terms).flat().map((term) => term.label).join(" ") : "";

	for (const entry of articles.entries) {
		const body = [entry.data.deck, entry.data.excerpt, extractPlainText(entry.data.content)]
			.filter(Boolean)
			.join(" ");
		consider("articles", entry.id, entry.id, entry.data.title, body, termLabels(entry.data.terms));
	}
	for (const entry of pages.entries) {
		consider("pages", entry.id, entry.id, entry.data.title, extractPlainText(entry.data.content));
	}

	return hits;
}

function buildSnippet(body: string, needle: string, radius = 40): string {
	const index = body.toLowerCase().indexOf(needle);
	if (index === -1) return body.slice(0, radius * 2);
	const start = Math.max(0, index - radius);
	const end = Math.min(body.length, index + needle.length + radius);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < body.length ? "…" : "";
	return `${prefix}${body.slice(start, end)}${suffix}`;
}
