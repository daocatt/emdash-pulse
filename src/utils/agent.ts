/**
 * Agent Read API 的序列化工具。
 *
 * 目标：为 agent 提供**稳定、结构化**的只读表示 —— 正文同时给出
 * Portable Text（`content`）、纯文本（`text`）与 markdown（`markdown`），
 * 图片给出可直接访问的 URL + 尺寸 + alt，时间统一 ISO 8601 UTC。
 */

import type { ContentEntry, InferCollectionData } from "emdash";
import { resolveMediaUrl, resolveMediaAlt, resolveGallery } from "./media";
import { extractPlainText } from "./text";
import { SITE_TIMEZONE } from "./format";

export type ArticleEntry = ContentEntry<InferCollectionData<"articles">>;
export type EditionEntry = ContentEntry<InferCollectionData<"editions">>;

export interface AgentImage {
	url: string;
	alt: string;
	width?: number;
	height?: number;
	caption?: string;
	credit?: string;
}

export interface AgentArticleSummary {
	slug: string;
	title: string;
	deck: string | null;
	excerpt: string | null;
	article_type: string;
	section: { slug: string; label: string } | null;
	tags: { slug: string; label: string }[];
	edition: string | null;
	author_agent: string | null;
	authors: string[];
	source: string | null;
	source_url: string | null;
	is_breaking: boolean;
	published_at: string | null;
	updated_at: string | null;
	url: string;
	image: AgentImage | null;
	gallery_count: number;
}

export interface AgentArticleDetail extends AgentArticleSummary {
	content: unknown;
	text: string;
	markdown: string;
	correction: string | null;
	images: AgentImage[];
	comments_allowed: boolean;
}

const iso = (value: unknown): string | null => {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value as string);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** 把相对媒体路径转为绝对 URL，便于 agent 直接抓取。 */
function absolute(url: string, siteUrl: URL): string {
	if (/^https?:\/\//i.test(url)) return url;
	return new URL(url.startsWith("/") ? url : `/${url}`, siteUrl).href;
}

function toImage(media: unknown, fallbackAlt = "", siteUrl?: URL): AgentImage | null {
	const raw = resolveMediaUrl(media);
	if (!raw) return null;
	const url = siteUrl ? absolute(raw, siteUrl) : raw;
	const record = (media ?? {}) as Record<string, unknown>;
	const width = typeof record.width === "number" ? record.width : undefined;
	const height = typeof record.height === "number" ? record.height : undefined;
	return { url, alt: resolveMediaAlt(media, fallbackAlt), width, height };
}

export function serializeArticleSummary(entry: ArticleEntry, siteUrl: URL): AgentArticleSummary {
	const data = entry.data;
	const section = data.terms?.section?.[0] ?? null;
	return {
		slug: entry.id,
		title: data.title,
		deck: data.deck ?? null,
		excerpt: data.excerpt ?? null,
		article_type: data.article_type,
		section: section ? { slug: section.slug, label: section.label } : null,
		tags: (data.terms?.tag ?? []).map((tag) => ({ slug: tag.slug, label: tag.label })),
		edition: data.terms?.edition?.[0]?.slug ?? null,
		author_agent: data.author_agent ?? null,
		authors: (data.bylines ?? []).map((credit) => credit.byline.displayName),
		source: data.source ?? null,
		source_url: data.source_url ?? null,
		is_breaking: Boolean(data.is_breaking),
		published_at: iso(data.publishedAt),
		updated_at: iso(data.updatedAt),
		url: new URL(`/articles/${entry.id}`, siteUrl).href,
		image: toImage(data.featured_image, data.title, siteUrl),
		gallery_count: resolveGallery(data.gallery).length,
	};
}

export function serializeArticleDetail(entry: ArticleEntry, siteUrl: URL): AgentArticleDetail {
	const data = entry.data;
	const gallery = resolveGallery(data.gallery).map((item) => ({
		url: absolute(item.url, siteUrl),
		alt: item.alt,
		caption: item.caption,
		credit: item.credit,
	}));
	const hero = toImage(data.featured_image, data.title, siteUrl);
	const images: AgentImage[] = [];
	if (hero) images.push({ ...hero, caption: data.image_caption, credit: data.photo_credit });
	for (const item of gallery) images.push(item);

	return {
		...serializeArticleSummary(entry, siteUrl),
		content: data.content ?? [],
		text: extractPlainText(data.content),
		markdown: portableTextToMarkdown(data.content, siteUrl),
		correction: data.correction ?? null,
		images,
		comments_allowed: data.allow_comments !== false,
	};
}

export function serializeEdition(entry: EditionEntry, siteUrl: URL) {
	const data = entry.data;
	return {
		slug: entry.id,
		title: data.title,
		period_type: data.period_type,
		year: data.year,
		period_no: data.period_no,
		summary: data.summary ?? null,
		published_at: iso(data.publishedAt),
		url: new URL(`/editions/${entry.id}`, siteUrl).href,
		cover: toImage(data.cover_image, data.title, siteUrl),
	};
}

/** 站点元信息，供各端点复用。 */
export function siteContext(siteUrl: URL, title: string, tagline: string) {
	return {
		site: title,
		description: tagline,
		url: siteUrl.href,
		timezone: SITE_TIMEZONE,
		generated_at: new Date().toISOString(),
	};
}

export function jsonResponse(data: unknown, init: { status?: number; maxAge?: number } = {}): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status: init.status ?? 200,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": `public, max-age=${init.maxAge ?? 300}`,
			"Access-Control-Allow-Origin": "*",
		},
	});
}

// ---------- Portable Text → Markdown ----------

interface PtSpan {
	_type?: string;
	text?: string;
	marks?: string[];
}

interface PtBlock {
	_type?: string;
	style?: string;
	listItem?: string;
	level?: number;
	children?: PtSpan[];
	markDefs?: { _key?: string; _type?: string; href?: string }[];
	alt?: string;
	caption?: string;
	url?: string;
	asset?: unknown;
	media?: unknown;
	language?: string;
	code?: string;
}

const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

function renderSpan(span: PtSpan, markDefs: Map<string, { _type?: string; href?: string }>): string {
	let text = span.text ?? "";
	for (const mark of span.marks ?? []) {
		const def = markDefs.get(mark);
		if (def?._type === "link" && def.href) {
			text = `[${text}](${def.href})`;
		} else if (mark === "strong") {
			text = `**${text}**`;
		} else if (mark === "em") {
			text = `*${text}*`;
		} else if (mark === "code") {
			text = `\`${text}\``;
		} else if (mark === "underline") {
			text = `<u>${text}</u>`;
		} else if (mark === "strike-through") {
			text = `~~${text}~~`;
		}
	}
	return text;
}

/** 把 EmDash Portable Text 转成 markdown（尽力而为，供 agent 阅读）。 */
export function portableTextToMarkdown(value: unknown, siteUrl?: URL): string {
	if (!Array.isArray(value)) return "";
	const blocks = value as PtBlock[];
	const lines: string[] = [];
	let listIndex = 0;

	for (const block of blocks) {
		if (block._type === "block") {
			const markDefs = new Map((block.markDefs ?? []).map((def) => [def._key ?? "", def]));
			const text = (block.children ?? []).map((span) => renderSpan(span, markDefs)).join("");

			if (block.listItem === "number") {
				listIndex += 1;
				lines.push(`${listIndex}. ${text}`);
				continue;
			}
			listIndex = 0;
			if (block.listItem === "bullet") {
				lines.push(`- ${text}`);
				continue;
			}
			if (block.style && HEADING.has(block.style)) {
				lines.push(`${"#".repeat(Number(block.style[1]))} ${text}`);
				continue;
			}
			if (block.style === "blockquote") {
				lines.push(`> ${text}`);
				continue;
			}
			lines.push(text);
			continue;
		}

		if (block._type === "image") {
			const raw = resolveMediaUrl(block.media ?? block.asset ?? block) ?? block.url;
			if (raw) {
				const url = siteUrl ? absolute(raw, siteUrl) : raw;
				lines.push(`![${block.alt ?? block.caption ?? ""}](${url})`);
			}
			continue;
		}

		if (block._type === "code") {
			lines.push(`\`\`\`${block.language ?? ""}\n${block.code ?? ""}\n\`\`\``);
			continue;
		}

		// 未知块类型：退化为纯文本
		const fallback = extractPlainText([block] as never);
		if (fallback) lines.push(fallback);
	}

	return lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}
