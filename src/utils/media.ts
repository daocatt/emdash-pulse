/**
 * 媒体字段解析工具。
 *
 * 图片字段是对象（`{ id, meta: { storageKey }, alt, ... }`）。发布/预览路径可能返回：
 *   - seed / 上传落库的 MediaValue（**没有 `src`**，只有 `meta.storageKey`）
 *   - 完整媒体对象（含 src）
 *   - 仅含 id（用媒体文件端点兜底）
 *   - repeater 子字段 `{ image, caption, credit }`
 */

import type { ImageValue } from "emdash";

export interface MediaLike {
	id?: string;
	src?: string;
	alt?: string;
	filename?: string;
	previewUrl?: string;
	image?: MediaLike | null;
	/** 落库的 MediaValue 只带 storage key（带扩展名），本地 provider 靠它解析 URL。 */
	meta?: { storageKey?: string } | null;
	$media?: { url?: string; alt?: string; filename?: string } | null;
}

const MEDIA_FILE_BASE = "/_emdash/api/media/file";

/**
 * 解析出可直接用于 <img src> 的 URL；无法解析时返回 null。
 *
 * 顺序对齐 EmDash 的 `buildRenderMediaUrl`：storage key → src → 其余 → 裸 id。
 * **`meta.storageKey` 必须排在 `id` 前面**：媒体文件路由
 * `/_emdash/api/media/file/{key}` 只认 storage key，传 `id`（媒体行 ULID）会 404。
 */
export function resolveMediaUrl(input: unknown): string | null {
	if (!input) return null;
	if (typeof input === "string") return input;
	if (typeof input !== "object") return null;

	const item = input as MediaLike;
	if (item.meta?.storageKey) return `${MEDIA_FILE_BASE}/${item.meta.storageKey}`;
	if (item.src) return item.src;
	if (item.previewUrl) return item.previewUrl;
	if (item.$media?.url) return item.$media.url;
	if (item.image) return resolveMediaUrl(item.image);
	if (item.id) return `${MEDIA_FILE_BASE}/${item.id}`;
	return null;
}

/** 解析图片替代文本；缺省时回退到 filename 或空串。 */
export function resolveMediaAlt(input: unknown, fallback = ""): string {
	if (!input || typeof input !== "object") return fallback;
	const item = input as MediaLike;
	if (item.alt) return item.alt;
	if (item.$media?.alt) return item.$media.alt;
	if (item.image) return resolveMediaAlt(item.image, fallback);
	return item.filename ?? item.$media?.filename ?? fallback;
}

/** 图集项：兼容 `{ image, caption, credit }` 与裸图片对象。 */
export interface GalleryItem {
	/** 解析后的 URL，用于灯箱大图。 */
	url: string;
	/** 原始媒体值，交给 `emdash/ui` 的 `<Image>` 生成响应式 srcset。 */
	image: ImageValue | string | null;
	alt: string;
	caption?: string;
	credit?: string;
}

export function resolveGallery(gallery: unknown): GalleryItem[] {
	if (!Array.isArray(gallery)) return [];
	const items: GalleryItem[] = [];
	for (const raw of gallery) {
		const url = resolveMediaUrl(raw);
		if (!url) continue;
		const record = (raw ?? {}) as Record<string, unknown>;
		const image = (record.image ?? raw) as ImageValue | string | null;
		items.push({
			url,
			image,
			alt: resolveMediaAlt(image, (record.caption as string) ?? ""),
			caption: typeof record.caption === "string" ? record.caption : undefined,
			credit: typeof record.credit === "string" ? record.credit : undefined,
		});
	}
	return items;
}
