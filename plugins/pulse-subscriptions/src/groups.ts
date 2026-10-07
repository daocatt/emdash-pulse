/**
 * 订阅分组：插件存储 `groups` 的读写封装。
 *
 * 分组是**叠加的细分段**：读者订阅时勾选，一条订阅记录用 `groups: string[]`
 * （slug 列表）持有；一个都不勾 = 主刊订阅者，不影响订阅本身。
 *
 * `slug` 同时是记录 id，**创建后不可变** —— 改 slug 会打断所有订阅者记录里的引用。
 * 后台只允许改显示名 / 描述 / 排序 / 启用状态。
 */

import type { PluginContext } from "emdash/plugin";

export interface GroupRecord {
	/** 显示名。 */
	name: string;
	description?: string;
	/** 升序排序；相同则按名称。 */
	sortOrder: number;
	/** 停用后不出现在前台表单，但保留已有订阅关系。 */
	active: boolean;
	createdAt: string;
	updatedAt?: string;
}

export interface GroupQueryOptions {
	where?: Record<string, unknown>;
	orderBy?: Record<string, "asc" | "desc">;
	limit?: number;
	cursor?: string;
}

export interface GroupStore {
	get(id: string): Promise<GroupRecord | null>;
	put(id: string, data: GroupRecord): Promise<void>;
	delete(id: string): Promise<boolean>;
	exists(id: string): Promise<boolean>;
	query(
		options?: GroupQueryOptions,
	): Promise<{ items: Array<{ id: string; data: GroupRecord }>; cursor?: string; hasMore: boolean }>;
	count(where?: Record<string, unknown>): Promise<number>;
}

export function groupStore(ctx: PluginContext): GroupStore {
	return ctx.storage.groups as unknown as GroupStore;
}

/** 分组 slug 的允许形状：小写字母、数字、连字符，1–40 字符。 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isValidSlug(value: string): boolean {
	return SLUG_PATTERN.test(value);
}

/** 由名称推导一个候选 slug（后台新建分组时预填）。 */
export function slugify(value: string): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return isValidSlug(slug) ? slug : "";
}

export interface GroupListEntry {
	slug: string;
	data: GroupRecord;
}

/** 全部分组（按 sortOrder 升序、其次名称），供后台与前台共用。 */
export async function listGroups(ctx: PluginContext): Promise<GroupListEntry[]> {
	const store = groupStore(ctx);
	const items: Array<{ id: string; data: GroupRecord }> = [];
	let cursor: string | undefined;

	// 分组数量天然很小（运营手工维护），但仍走完整翻页以免将来踩到默认分页上限。
	for (;;) {
		const page = await store.query({
			orderBy: { sortOrder: "asc" },
			limit: 200,
			...(cursor ? { cursor } : {}),
		});
		items.push(...page.items);
		if (!page.hasMore || !page.cursor) break;
		cursor = page.cursor;
	}

	return items
		.map((item) => ({ slug: item.id, data: item.data }))
		.sort((a, b) => a.data.sortOrder - b.data.sortOrder || a.data.name.localeCompare(b.data.name));
}

/** 只取启用中的分组（前台表单用）。 */
export async function listActiveGroups(ctx: PluginContext): Promise<GroupListEntry[]> {
	return (await listGroups(ctx)).filter((group) => group.data.active);
}

/**
 * 把一批 slug 收敛为「存在且启用」的集合。
 *
 * 前台提交的 slug 不可信：过滤掉不存在的、已停用的、以及重复项。
 */
export async function sanitizeGroupSlugs(ctx: PluginContext, slugs: readonly string[]): Promise<string[]> {
	if (slugs.length === 0) return [];
	const active = new Set((await listActiveGroups(ctx)).map((group) => group.slug));
	const seen = new Set<string>();
	for (const slug of slugs) {
		if (active.has(slug)) seen.add(slug);
	}
	return [...seen];
}

export interface SaveGroupInput {
	/** 新建时的目标 slug；更新时用它定位记录。 */
	slug?: string;
	name: string;
	description?: string;
	sortOrder?: number;
	active?: boolean;
	/**
	 * `true` = 新建（slug 必须不存在）；缺省 = 更新（slug 必须已存在）。
	 *
	 * 分开是刻意的：分组名多为中文，推不出合法 slug，所以新建时由后台显式填；
	 * 而「填了已存在的 slug」在新建语境下是错误而不是隐式覆盖。
	 */
	create?: boolean;
}

export type SaveGroupResult =
	| { ok: true; slug: string; created: boolean }
	| { ok: false; error: "INVALID_SLUG" | "DUPLICATE_SLUG" | "INVALID_NAME" };

/** 新建 / 更新分组。 */
export async function saveGroup(ctx: PluginContext, input: SaveGroupInput): Promise<SaveGroupResult> {
	const name = input.name.trim();
	if (!name) return { ok: false, error: "INVALID_NAME" };

	const store = groupStore(ctx);
	const now = new Date().toISOString();
	const description = input.description?.trim() || undefined;

	if (!input.create) {
		const slug = input.slug?.trim();
		if (!slug || !isValidSlug(slug)) return { ok: false, error: "INVALID_SLUG" };
		const existing = await store.get(slug);
		if (!existing) return { ok: false, error: "INVALID_SLUG" };
		await store.put(slug, {
			...existing,
			name,
			description,
			sortOrder: input.sortOrder ?? existing.sortOrder,
			active: input.active ?? existing.active,
			updatedAt: now,
		});
		return { ok: true, slug, created: false };
	}

	const slug = input.slug?.trim() || slugify(name);
	if (!slug || !isValidSlug(slug)) return { ok: false, error: "INVALID_SLUG" };
	if (await store.exists(slug)) return { ok: false, error: "DUPLICATE_SLUG" };

	await store.put(slug, {
		name,
		description,
		sortOrder: input.sortOrder ?? 0,
		active: input.active ?? true,
		createdAt: now,
	});
	return { ok: true, slug, created: true };
}

/** 删除分组。调用方负责从订阅者记录里剔除该 slug（见 `subscribers/update`）。 */
export async function deleteGroup(ctx: PluginContext, slug: string): Promise<boolean> {
	return groupStore(ctx).delete(slug);
}
