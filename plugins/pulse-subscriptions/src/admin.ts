/**
 * 后台 Block Kit 页面：`/subscribers`（订阅者）与 `/groups`（订阅分组）。
 *
 * 两个页面走**同一个** `admin` 路由，靠交互里的 `page` 字段区分（值是 manifest 里的
 * `admin.pages[].path`，如 `/subscribers`）。
 *
 * 状态传递：宿主只回传 `block_action.value` / `form_submit.values` / `form_submit.block_id`，
 * **不带**上一次的表单值。所以列表的筛选条件必须内嵌进分页按钮的 value（见 `encodeState`），
 * 否则一翻页筛选就丢。
 *
 * 行级操作照仓库既有约定用 `"<action>:<id>"` 编码（见 pulse-agent）。
 */

import type { PluginContext } from "emdash/plugin";

import { listBroadcastHistory, sendBroadcastToSegment } from "./broadcast";
import { listEvents, recordEvent, type EventType } from "./events";
import { deleteGroup, listGroups, saveGroup } from "./groups";
import {
	pauseSubscriber,
	resumeSubscriber,
	setSubscriberGroups,
	unsubscribeSubscriber,
} from "./operations";
import { readSyncSettings } from "./segments";
import {
	MAX_SCAN,
	maskEmail,
	scanSubscribers,
	subscriberStore,
	type SubscriberRecord,
	type SubscriberStatus,
} from "./subscribers";
import { resolveTransport } from "./transport";

type Json = Record<string, unknown>;

export interface AdminResponse {
	blocks: Json[];
	toast?: { message: string; type: "success" | "error" | "info" };
}

export const ADMIN_PAGE_SUBSCRIBERS = "/subscribers";
export const ADMIN_PAGE_GROUPS = "/groups";
export const ADMIN_PAGE_BROADCAST = "/broadcast";

const PAGE_SIZE = 20;

const STATUS_LABEL: Record<SubscriberStatus, string> = {
	pending: "待确认",
	confirmed: "已确认",
	unsubscribed: "已退订",
	paused: "已暂停",
};

const STATUS_FILTER_OPTIONS = [
	{ label: "全部", value: "all" },
	{ label: "已确认", value: "confirmed" },
	{ label: "待确认", value: "pending" },
	{ label: "已暂停", value: "paused" },
	{ label: "已退订", value: "unsubscribed" },
];

const EVENT_LABEL: Record<EventType, string> = {
	requested: "提交订阅",
	confirmed: "确认订阅",
	unsubscribed: "退订",
	paused: "暂停",
	resumed: "恢复",
	groups_changed: "改分组",
	request_blocked: "订阅被拦截",
	resend_sync_failed: "Resend 同步失败",
	email_delivered: "邮件已送达",
	email_bounced: "邮件退信",
	email_complained: "标记垃圾邮件",
	email_opened: "邮件已打开",
	email_clicked: "链接已点击",
};

const ACTOR_LABEL: Record<string, string> = {
	reader: "读者",
	admin: "后台",
	system: "系统",
};

// ---------- 列表状态与游标 ----------
//
// 宿主翻页只回传我们塞进按钮 value 的字符串，所以「筛选 + 页码」整体编码进去。

interface ListState {
	status: "all" | SubscriberStatus;
	group: string;
	q: string;
	page: number;
}

const DEFAULT_STATE: ListState = { status: "all", group: "", q: "", page: 1 };

function encodeState(state: ListState): string {
	return encodeURIComponent(JSON.stringify(state));
}

function decodeState(value: unknown): ListState {
	if (typeof value !== "string" || !value) return DEFAULT_STATE;
	try {
		const parsed = JSON.parse(decodeURIComponent(value)) as Partial<ListState>;
		const status = parsed.status;
		return {
			status:
				status === "pending" || status === "confirmed" || status === "unsubscribed" || status === "paused"
					? status
					: "all",
			group: typeof parsed.group === "string" ? parsed.group : "",
			q: typeof parsed.q === "string" ? parsed.q : "",
			page: typeof parsed.page === "number" && parsed.page >= 1 ? Math.floor(parsed.page) : 1,
		};
	} catch {
		return DEFAULT_STATE;
	}
}

/** `"<action>:<id>"` —— id 形如 `sub_<hex>`，不含冒号，故按首个冒号切分。 */
function parseRowValue(value: unknown): { action: string; id: string } {
	if (typeof value !== "string") return { action: "", id: "" };
	const at = value.indexOf(":");
	if (at < 0) return { action: value, id: "" };
	return { action: value.slice(0, at), id: value.slice(at + 1) };
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

// ---------- 过滤 / 统计 ----------

interface ScanSummary {
	items: Array<{ id: string; data: SubscriberRecord }>;
	truncated: boolean;
	counts: Record<SubscriberStatus, number>;
	groupCounts: Map<string, number>;
}

async function scanSummary(ctx: PluginContext): Promise<ScanSummary> {
	const { items, truncated } = await scanSubscribers(ctx);
	const counts: Record<SubscriberStatus, number> = {
		pending: 0,
		confirmed: 0,
		unsubscribed: 0,
		paused: 0,
	};
	const groupCounts = new Map<string, number>();

	for (const item of items) {
		counts[item.data.status] += 1;
		for (const slug of item.data.groups ?? []) {
			groupCounts.set(slug, (groupCounts.get(slug) ?? 0) + 1);
		}
	}
	return { items, truncated, counts, groupCounts };
}

function filterItems(
	items: ScanSummary["items"],
	state: ListState,
): ScanSummary["items"] {
	const needle = state.q.trim().toLowerCase();
	return items.filter((item) => {
		if (state.status !== "all" && item.data.status !== state.status) return false;
		if (state.group && !(item.data.groups ?? []).includes(state.group)) return false;
		if (needle && !item.data.email.toLowerCase().includes(needle)) return false;
		return true;
	});
}

// ---------- 订阅者页 ----------

async function subscriberListBlocks(
	ctx: PluginContext,
	state: ListState,
): Promise<Json[]> {
	const summary = await scanSummary(ctx);
	const groups = await listGroups(ctx);
	const groupName = new Map(groups.map((group) => [group.slug, group.data.name]));

	const filtered = filterItems(summary.items, state);
	const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	const page = Math.min(state.page, totalPages);
	const start = (page - 1) * PAGE_SIZE;
	const pageItems = filtered.slice(start, start + PAGE_SIZE);

	const rows = pageItems.map((item) => {
		const record = item.data;
		const items: Json[] = [];
		if (record.status === "paused") {
			items.push({ label: "恢复订阅", value: `resume:${item.id}` });
		} else if (record.status !== "unsubscribed") {
			items.push({ label: "暂停订阅", value: `pause:${item.id}` });
		}
		if (record.status !== "unsubscribed") {
			items.push({ label: "退订", value: `unsubscribe:${item.id}` });
		}
		items.push({ label: "改分组", value: `groups:${item.id}` });
		items.push({ label: "订阅记录", value: `events:${item.id}` });

		return {
			email: maskEmail(record.email),
			status: STATUS_LABEL[record.status],
			groups: (record.groups ?? []).map((slug) => groupName.get(slug) ?? slug).join("、") || "主刊",
			source: record.source ?? "—",
			created: record.createdAt,
			action: { type: "menu", action_id: "subscriber-action", label: "操作", items },
		};
	});

	const blocks: Json[] = [
		{ type: "header", text: "读者订阅" },
		{
			type: "stats",
			items: [
				{ label: "已确认", value: summary.counts.confirmed },
				{ label: "待确认", value: summary.counts.pending },
				{ label: "已暂停", value: summary.counts.paused },
				{ label: "已退订", value: summary.counts.unsubscribed },
			],
		},
	];

	if (summary.truncated) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "结果被截断",
			description: `订阅者超过 ${MAX_SCAN} 条，只扫描了前 ${MAX_SCAN} 条。请用下面的筛选收窄范围后再操作。`,
		});
	}

	blocks.push(
		{ type: "divider" },
		{
			type: "form",
			block_id: "subscriber-filter",
			fields: [
				{
					type: "select",
					action_id: "status",
					label: "状态",
					options: STATUS_FILTER_OPTIONS,
					initial_value: state.status,
				},
				{
					type: "select",
					action_id: "group",
					label: "分组",
					options: [
						{ label: "全部", value: "" },
						...groups.map((group) => ({ label: group.data.name, value: group.slug })),
					],
					initial_value: state.group,
				},
				{
					type: "text_input",
					action_id: "q",
					label: "邮箱关键词",
					initial_value: state.q,
				},
			],
			submit: { label: "筛选", action_id: "subscriber-filter-apply" },
		},
		{
			type: "table",
			columns: [
				{ key: "email", label: "邮箱" },
				{ key: "status", label: "状态", format: "badge" },
				{ key: "groups", label: "分组" },
				{ key: "source", label: "来源" },
				{ key: "created", label: "创建时间", format: "relative_time" },
				{ key: "action", label: "操作", format: "element" },
			],
			rows,
			page_action_id: "subscribers-page",
			empty_text: "没有符合条件的订阅者。",
		},
	);

	// 分页用显式按钮而不是 table 的 next_cursor：宿主只回传按钮 value，
	// 正好把「筛选 + 页码」整体带回来，翻页不会丢筛选。
	if (totalPages > 1) {
		blocks.push({
			type: "actions",
			elements: [
				...(page > 1
					? [
							{
								type: "button",
								label: "← 上一页",
								action_id: "subscribers-page",
								value: encodeState({ ...state, page: page - 1 }),
							},
						]
					: []),
				...(page < totalPages
					? [
							{
								type: "button",
								label: "下一页 →",
								action_id: "subscribers-page",
								value: encodeState({ ...state, page: page + 1 }),
							},
						]
					: []),
			],
		});
	}

	blocks.push({
		type: "context",
		text: `第 ${page} / ${totalPages} 页 · 命中 ${filtered.length} 条 · 邮箱已脱敏，操作立即生效。`,
	});

	return blocks;
}

async function subscriberGroupsBlocks(
	ctx: PluginContext,
	id: string,
	notice?: string,
): Promise<AdminResponse> {
	const record = await subscriberStore(ctx).get(id);
	if (!record) {
		return { blocks: await subscriberListBlocks(ctx, DEFAULT_STATE), toast: { message: "订阅者不存在", type: "error" } };
	}

	const groups = await listGroups(ctx);
	const blocks: Json[] = [
		{ type: "header", text: `订阅分组 · ${maskEmail(record.email)}` },
		{ type: "section", text: `当前状态：**${STATUS_LABEL[record.status]}**` },
	];
	if (notice) blocks.push({ type: "section", text: notice });
	blocks.push({ type: "divider" });

	if (groups.length === 0) {
		blocks.push({
			type: "empty",
			title: "还没有分组",
			description: "先到「订阅分组」页创建分组，再回到这里给订阅者分配。",
		});
	} else {
		blocks.push({
			type: "form",
			// block_id 带订阅者 id：form_submit 只回传 values，靠它定位记录。
			block_id: `subscriber-groups:${id}`,
			fields: [
				{
					type: "checkbox",
					action_id: "groups",
					label: "订阅分组（一个都不勾 = 只收主刊）",
					options: groups.map((group) => ({
						label: group.data.active ? group.data.name : `${group.data.name}（已停用）`,
						value: group.slug,
					})),
					initial_value: record.groups ?? [],
				},
			],
			submit: { label: "保存分组", action_id: "subscriber-groups-save" },
		});
	}

	blocks.push({
		type: "actions",
		elements: [{ type: "button", label: "← 返回列表", action_id: "subscriber-back", value: "back" }],
	});

	return { blocks };
}

async function subscriberEventsBlocks(ctx: PluginContext, id: string): Promise<AdminResponse> {
	const record = await subscriberStore(ctx).get(id);
	if (!record) {
		return { blocks: await subscriberListBlocks(ctx, DEFAULT_STATE), toast: { message: "订阅者不存在", type: "error" } };
	}

	const events = await listEvents(ctx, id, 100);
	const rows = events.map((event) => ({
		at: event.data.at,
		type: EVENT_LABEL[event.data.type] ?? event.data.type,
		actor: ACTOR_LABEL[event.data.actor] ?? event.data.actor,
		detail: [event.data.reason, event.data.detail].filter(Boolean).join(" · ") || "—",
	}));

	return {
		blocks: [
			{ type: "header", text: `订阅记录 · ${maskEmail(record.email)}` },
			{ type: "section", text: `当前状态：**${STATUS_LABEL[record.status]}**` },
			{ type: "divider" },
			{
				type: "table",
				columns: [
					{ key: "at", label: "时间", format: "relative_time" },
					{ key: "type", label: "事件" },
					{ key: "actor", label: "操作者" },
					{ key: "detail", label: "说明" },
				],
				rows,
				page_action_id: "subscriber-events-page",
				empty_text: "暂无记录。",
			},
			{
				type: "actions",
				elements: [{ type: "button", label: "← 返回列表", action_id: "subscriber-back", value: "back" }],
			},
		],
	};
}

// ---------- 分组页 ----------

async function groupsBlocks(ctx: PluginContext, editing: string | null, notice?: string): Promise<Json[]> {
	const groups = await listGroups(ctx);
	const summary = await scanSummary(ctx);

	const blocks: Json[] = [
		{ type: "header", text: "订阅分组" },
		{
			type: "stats",
			items: [
				{ label: "分组总数", value: groups.length },
				{ label: "启用中", value: groups.filter((group) => group.data.active).length },
				{ label: "已分组订阅者", value: summary.groupCounts.size },
			],
		},
	];
	if (notice) blocks.push({ type: "section", text: notice });
	blocks.push({ type: "divider" });

	const target = editing ? groups.find((group) => group.slug === editing) : undefined;

	blocks.push({
		type: "form",
		block_id: target ? `group-save:${target.slug}` : "group-save",
		fields: [
			{ type: "text_input", action_id: "name", label: "名称", initial_value: target?.data.name ?? "" },
			// 名称多为中文，推不出合法 slug，所以新建时显式填；编辑时 slug 不可改。
			...(target
				? []
				: [
						{
							type: "text_input",
							action_id: "slug",
							label: "标识 slug（小写字母 / 数字 / 连字符，创建后不可改）",
							initial_value: "",
						},
					]),
			{
				type: "text_input",
				action_id: "description",
				label: "描述（选填）",
				initial_value: target?.data.description ?? "",
			},
			{
				type: "number_input",
				action_id: "sortOrder",
				label: "排序（小在前）",
				initial_value: target?.data.sortOrder ?? 0,
			},
			{ type: "toggle", action_id: "active", label: "启用", initial_value: target?.data.active ?? true },
		],
		submit: { label: target ? `保存「${target.data.name}」` : "新建分组", action_id: "group-save" },
	});

	if (target) {
		blocks.push({
			type: "actions",
			elements: [{ type: "button", label: "取消编辑", action_id: "group-cancel", value: "cancel" }],
		});
	}

	blocks.push({
		type: "table",
		columns: [
			{ key: "name", label: "名称" },
			{ key: "slug", label: "slug", format: "code" },
			{ key: "members", label: "订阅人数", format: "number" },
			{ key: "status", label: "状态", format: "badge" },
			{ key: "sort", label: "排序", format: "number" },
			{ key: "action", label: "操作", format: "element" },
		],
		rows: groups.map((group) => ({
			name: group.data.name,
			slug: group.slug,
			members: summary.groupCounts.get(group.slug) ?? 0,
			status: group.data.active ? "启用" : "停用",
			sort: group.data.sortOrder,
			action: {
				type: "menu",
				action_id: "group-action",
				label: "操作",
				items: [
					{ label: "编辑", value: `edit:${group.slug}` },
					{ label: "删除", value: `delete:${group.slug}` },
				],
			},
		})),
		page_action_id: "groups-page",
		empty_text: "还没有分组。用上面的表单新建一个。",
	});

	blocks.push({
		type: "context",
		text: "slug 创建后不可修改（订阅者记录按 slug 引用）；停用只影响前台表单，已有订阅关系保留。",
	});

	return blocks;
}

// ---------- 分派 ----------

/** 后台交互输入（`page_load` / `block_action` / `form_submit` 的并集，只取用到的字段）。 */
export interface AdminInput {
	type?: string;
	action_id?: string;
	block_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
	page?: string;
}

export async function renderAdmin(ctx: PluginContext, input: AdminInput): Promise<AdminResponse> {
	const page = typeof input.page === "string" && input.page ? input.page : ADMIN_PAGE_SUBSCRIBERS;

	if (page === ADMIN_PAGE_GROUPS) return renderGroupsPage(ctx, input);
	if (page === ADMIN_PAGE_BROADCAST) return renderBroadcastPage(ctx, input);
	return renderSubscribersPage(ctx, input);
}

// ---------- 订阅群发（Resend Broadcasts）----------

/**
 * 群发页。
 *
 * 收件人池是 **Resend segment**（= 一个订阅分组），不是本地邮箱列表 ——
 * 群发走 `POST /broadcasts`，由 Resend 展开收件人、插入退订链接、遵守
 * contact 的 `unsubscribed` 状态。因此这里只让编辑选「发给哪个分组」。
 *
 * 发送不可撤销，所以表单里放一个必须打开的确认开关。
 */
async function renderBroadcastPage(ctx: PluginContext, input: AdminInput): Promise<AdminResponse> {
	if (input.type === "form_submit" && input.action_id === "broadcast-send") {
		const confirmed = input.values?.confirm === true;
		const subject = str(input.values?.subject).trim();
		const html = str(input.values?.html).trim();
		const segmentSlug = str(input.values?.segment);

		if (!confirmed) {
			return { blocks: await broadcastBlocks(ctx, "⚠️ 请先勾选确认再发送。"), toast: { message: "未勾选确认", type: "error" } };
		}
		if (subject === "" || html === "") {
			return { blocks: await broadcastBlocks(ctx, "⚠️ 主题与正文都不能为空。"), toast: { message: "主题/正文为空", type: "error" } };
		}
		if (segmentSlug === "") {
			return { blocks: await broadcastBlocks(ctx, "⚠️ 请选择目标分组。"), toast: { message: "未选择分组", type: "error" } };
		}

		const result = await sendBroadcastToSegment(ctx, { subject, html, segmentSlug, actor: "admin" });
		if (!result.ok) {
			return {
				blocks: await broadcastBlocks(ctx, `❌ 发送失败：**${result.error}**`),
				toast: { message: `发送失败：${result.error}`, type: "error" },
			};
		}
		return {
			blocks: await broadcastBlocks(ctx, `✅ 已提交 Resend（broadcast ${result.resendId}）。`),
			toast: { message: "已提交群发", type: "success" },
		};
	}

	return { blocks: await broadcastBlocks(ctx) };
}

async function broadcastBlocks(ctx: PluginContext, notice?: string): Promise<Json[]> {
	const [groups, history, sync, transport] = await Promise.all([
		listGroups(ctx),
		listBroadcastHistory(ctx, 20),
		readSyncSettings(ctx),
		resolveTransport(ctx),
	]);

	// 当前投递通道（默认 Resend，见 src/transport/）。换 provider 时这里自动跟随。
	const label = transport?.label ?? "邮件服务";
	const from = transport ? await transport.fromAddress() : "";
	const configured = transport !== null && from !== "" && (await transport.isConfigured());

	const blocks: Json[] = [
		{ type: "header", text: "订阅群发" },
		{
			type: "section",
			text: `群发走当前投递通道（**${label}**）：收件人是所选分组对应的受众，服务侧负责展开收件人、插入退订链接、并跳过已退订联系人。`,
		},
		{
			type: "context",
			text: configured
				? `${label} 已配置（From：${from}）· 分组同步：${sync.enabled ? "开启" : "关闭"}`
				: `⚠️ ${label} 未配置：请先到「Resend」设置页填 API Key 与 From 地址。`,
		},
	];
	if (notice) blocks.push({ type: "section", text: notice });
	blocks.push({ type: "divider" });

	const options = groups
		.filter((group) => group.data.active)
		.map((group) => ({ label: `${group.data.name}（${group.slug}）`, value: group.slug }));

	blocks.push({
		type: "form",
		block_id: "broadcast-send",
		fields: [
			{
				type: "select",
				action_id: "segment",
				label: "目标分组",
				options: options.length > 0 ? options : [{ label: "（没有启用中的分组）", value: "" }],
				initial_value: options[0]?.value ?? "",
			},
			{ type: "text_input", action_id: "subject", label: "主题", initial_value: "" },
			{
				type: "text_input",
				action_id: "html",
				label: "正文（HTML；可用 {{{RESEND_UNSUBSCRIBE_URL}}} 占位退订链接）",
				multiline: true,
				initial_value: "",
			},
			{
				type: "toggle",
				action_id: "confirm",
				label: "确认立即发送",
				description: "我确认立即向该分组的全部已确认订阅者发送（不可撤销）",
				initial_value: false,
			},
		],
		submit: { label: "创建并发送", action_id: "broadcast-send" },
	});

	blocks.push({
		type: "table",
		columns: [
			{ key: "subject", label: "主题" },
			{ key: "segment", label: "分组", format: "code" },
			{ key: "status", label: "状态", format: "badge" },
			{ key: "created", label: "时间", format: "relative_time" },
			{ key: "detail", label: "详情" },
		],
		rows: history.map((record) => ({
			subject: record.subject,
			segment: record.segmentSlug,
			status: record.status === "sent" ? "已发送" : "失败",
			created: record.createdAt,
			detail: record.status === "sent" ? record.resendId : (record.error ?? ""),
		})),
		page_action_id: "broadcast-page",
		empty_text: "还没有群发记录。",
	});

	return blocks;
}

async function renderSubscribersPage(ctx: PluginContext, input: AdminInput): Promise<AdminResponse> {
	// 行级操作 / 返回 / 分页
	if (input.type === "block_action") {
		if (input.action_id === "subscribers-page") {
			return { blocks: await subscriberListBlocks(ctx, decodeState(input.value)) };
		}
		if (input.action_id === "subscriber-back") {
			return { blocks: await subscriberListBlocks(ctx, DEFAULT_STATE) };
		}
		if (input.action_id === "subscriber-action") {
			const { action, id } = parseRowValue(input.value);
			return applySubscriberAction(ctx, action, id);
		}
	}

	// 分组编辑保存
	if (input.type === "form_submit" && input.action_id === "subscriber-groups-save") {
		const id = (input.block_id ?? "").split(":")[1] ?? "";
		if (!id) {
			return { blocks: await subscriberListBlocks(ctx, DEFAULT_STATE), toast: { message: "缺少订阅者标识", type: "error" } };
		}
		const result = await setSubscriberGroups(ctx, id, strArray(input.values?.groups), "admin");
		if (!result.ok) {
			return { blocks: await subscriberListBlocks(ctx, DEFAULT_STATE), toast: { message: "订阅者不存在", type: "error" } };
		}
		return {
			blocks: await subscriberListBlocks(ctx, DEFAULT_STATE),
			toast: { message: `已更新 ${maskEmail(result.record.email)} 的分组`, type: "success" },
		};
	}

	// 筛选
	if (input.type === "form_submit" && input.action_id === "subscriber-filter-apply") {
		const status = str(input.values?.status);
		const next: ListState = {
			status:
				status === "pending" || status === "confirmed" || status === "unsubscribed" || status === "paused"
					? status
					: "all",
			group: str(input.values?.group),
			q: str(input.values?.q).trim(),
			page: 1,
		};
		return { blocks: await subscriberListBlocks(ctx, next) };
	}

	return { blocks: await subscriberListBlocks(ctx, DEFAULT_STATE) };
}

async function applySubscriberAction(ctx: PluginContext, action: string, id: string): Promise<AdminResponse> {
	if (!id) return { blocks: await subscriberListBlocks(ctx, DEFAULT_STATE) };

	if (action === "groups") return subscriberGroupsBlocks(ctx, id);
	if (action === "events") return subscriberEventsBlocks(ctx, id);

	if (action === "pause") {
		const result = await pauseSubscriber(ctx, id, { by: "admin" });
		if (!result.ok) {
			return {
				blocks: await subscriberListBlocks(ctx, DEFAULT_STATE),
				toast: { message: result.error === "NOT_FOUND" ? "订阅者不存在" : "该状态无法暂停", type: "error" },
			};
		}
		return {
			blocks: await subscriberListBlocks(ctx, DEFAULT_STATE),
			toast: { message: `已暂停 ${maskEmail(result.record.email)} 的订阅`, type: "success" },
		};
	}

	if (action === "resume") {
		const result = await resumeSubscriber(ctx, id);
		if (!result.ok) {
			return {
				blocks: await subscriberListBlocks(ctx, DEFAULT_STATE),
				toast: { message: result.error === "NOT_FOUND" ? "订阅者不存在" : "该状态无法恢复", type: "error" },
			};
		}
		return {
			blocks: await subscriberListBlocks(ctx, DEFAULT_STATE),
			toast: { message: `已恢复 ${maskEmail(result.record.email)} 的订阅`, type: "success" },
		};
	}

	if (action === "unsubscribe") {
		const result = await unsubscribeSubscriber(ctx, id, { actor: "admin" });
		if (!result.ok) {
			return { blocks: await subscriberListBlocks(ctx, DEFAULT_STATE), toast: { message: "订阅者不存在", type: "error" } };
		}
		return {
			blocks: await subscriberListBlocks(ctx, DEFAULT_STATE),
			toast: { message: `已退订 ${maskEmail(result.record.email)}`, type: "success" },
		};
	}

	return { blocks: await subscriberListBlocks(ctx, DEFAULT_STATE) };
}

async function renderGroupsPage(ctx: PluginContext, input: AdminInput): Promise<AdminResponse> {
	// 点「编辑」/「删除」
	if (input.type === "block_action" && input.action_id === "group-action") {
		const { action, id } = parseRowValue(input.value);
		if (action === "edit") return { blocks: await groupsBlocks(ctx, id) };
		if (action === "delete") return deleteGroupFlow(ctx, id);
	}
	if (input.type === "block_action" && input.action_id === "group-cancel") {
		return { blocks: await groupsBlocks(ctx, null) };
	}

	// 新建 / 保存
	if (input.type === "form_submit" && input.action_id === "group-save") {
		return saveGroupFlow(ctx, input);
	}

	return { blocks: await groupsBlocks(ctx, null) };
}

async function saveGroupFlow(ctx: PluginContext, input: AdminInput): Promise<AdminResponse> {
	// block_id 形如 `group-save`（新建）或 `group-save:<slug>`（编辑）。
	const editing = (input.block_id ?? "").split(":")[1] || undefined;
	const name = str(input.values?.name).trim();
	const description = str(input.values?.description).trim();
	const sortOrderRaw = input.values?.sortOrder;
	const sortOrder = typeof sortOrderRaw === "number" ? sortOrderRaw : Number(str(sortOrderRaw)) || 0;
	const active = input.values?.active !== false;

	if (!name) {
		return { blocks: await groupsBlocks(ctx, editing ?? null, "⚠️ 名称不能为空。") };
	}

	const result = editing
		? await saveGroup(ctx, { slug: editing, name, description, sortOrder, active })
		: await saveGroup(ctx, {
				create: true,
				slug: str(input.values?.slug).trim(),
				name,
				description,
				sortOrder,
				active,
			});

	if (!result.ok) {
		const message =
			result.error === "DUPLICATE_SLUG"
				? "该 slug 已被占用，换一个。"
				: result.error === "INVALID_SLUG"
					? "slug 不合法：只能用小写字母、数字与连字符，且需以字母或数字开头。"
					: "名称无效。";
		return { blocks: await groupsBlocks(ctx, editing ?? null, `⚠️ ${message}`) };
	}

	return {
		blocks: await groupsBlocks(ctx, null, result.created ? `已新建分组 **${name}**。` : `已保存分组 **${name}**。`),
		toast: { message: result.created ? "分组已创建" : "分组已保存", type: "success" },
	};
}

async function deleteGroupFlow(ctx: PluginContext, slug: string): Promise<AdminResponse> {
	const target = (await listGroups(ctx)).find((group) => group.slug === slug);
	if (!target) {
		return { blocks: await groupsBlocks(ctx, null), toast: { message: "分组不存在", type: "error" } };
	}

	// 删除前先从订阅者记录里剔除该 slug，否则会留下悬空引用。
	const summary = await scanSummary(ctx);
	const store = subscriberStore(ctx);
	let cleaned = 0;
	for (const item of summary.items) {
		const groups = item.data.groups ?? [];
		if (!groups.includes(slug)) continue;
		const next = groups.filter((value) => value !== slug);
		await store.put(item.id, { ...item.data, groups: next });
		await recordEvent(ctx, {
			subscriberId: item.id,
			type: "groups_changed",
			actor: "admin",
			detail: next.join(","),
			reason: `分组「${target.data.name}」已删除`,
		});
		cleaned += 1;
	}

	await deleteGroup(ctx, slug);
	return {
		blocks: await groupsBlocks(ctx, null, `已删除分组 **${target.data.name}**${cleaned > 0 ? `，并从 ${cleaned} 位订阅者上移除` : ""}。`),
		toast: { message: "分组已删除", type: "success" },
	};
}
