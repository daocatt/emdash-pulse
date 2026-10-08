/**
 * Resend API 客户端（Segments / Contacts / Broadcasts）+ Webhook 验签。
 *
 * ## 为什么凭证从「Resend 插件」读
 *
 * API key 由 `emdash-plugin-resend`（id `emdash-resend`）的后台页写入插件设置
 * （`plugin:emdash-resend:settings:apiKey`，加密存储）。本插件不重复配置一份 ——
 * 插件设置按 plugin id 隔离（`ctx.settings` 只能读自己的），跨插件读只能靠
 * **动态** `import("emdash")` 拿 `getPluginSetting`（宿主同一份实例，见下方
 * `loadHost()` 对「为什么 specifier 必须是变量」的说明）。
 *
 * ## 约定
 *
 * - 所有函数**不抛错**：失败返回 `{ ok:false, error }`，由调用方降级。订阅主流程
 *   绝不能因为 Resend 抖动而失败。
 * - REST 字段名用 **snake_case**（`segment_id` / `first_name` / `reply_to`）。
 *   官方文档站展示的是 Node SDK 的 camelCase 表面，SDK 内部再转 snake_case；
 *   这里直连 REST，所以按 REST 约定写。
 * - Webhook 验签用 WebCrypto HMAC-SHA256（Svix 方案），无需额外依赖。
 */

export interface ResendConfig {
	apiKey: string;
	/** 发件地址（`Name <mail@example.com>`）。 */
	fromAddress: string;
}

const RESEND_ORIGIN = "https://api.resend.com";
/** 承载 API key 的插件 id（`emdash-plugin-resend` 的 descriptor id）。 */
const RESEND_PLUGIN_ID = "emdash-resend";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type ResendResult<T> =
	| { ok: true; data: T }
	| { ok: false; status: number; error: string };

/**
 * 读取 Resend 凭证。未配置（插件缺失 / 未填 key）时返回 `null`。
 */
export async function loadResendConfig(): Promise<ResendConfig | null> {
	try {
		const { getPluginSetting } = await loadHost();
		const [apiKey, fromAddress] = await Promise.all([
			getPluginSetting(RESEND_PLUGIN_ID, "apiKey").catch(() => undefined),
			getPluginSetting(RESEND_PLUGIN_ID, "fromAddress").catch(() => undefined),
		]);
		if (typeof apiKey !== "string" || apiKey === "") return null;
		return { apiKey, fromAddress: typeof fromAddress === "string" ? fromAddress : "" };
	} catch {
		return null;
	}
}

/** 宿主 `emdash` 模块里我们用到的那部分。 */
interface HostModule {
	getPluginSetting(pluginId: string, key: string): Promise<unknown>;
}

/**
 * 动态取宿主 `emdash` 模块。
 *
 * **specifier 必须是运行时变量**，不能写成字面量 —— 两个原因：
 *
 * 1. `emdash-plugin build`（rolldown）对**字面量** specifier 会尝试静态解析；
 *    解析不到就报 `Cannot find package 'emdash'`，整包构建失败。
 * 2. `tsc` 会对字面量 `import("emdash")` 做类型解析，把 EmDash 的**整张类型图**
 *    拉进来（`index.d.mts` + 30 余个 chunk），`tsc --noEmit` 直接 OOM。
 *
 * 变量 specifier 两条路都绕过：rolldown 无法静态分析 → 原样保留；TS 无法解析
 * → 类型为 `any`，由下面的断言收窄。运行时解析到的仍是宿主**同一份** `emdash`
 * 实例（`getDb()` 的 AsyncLocalStorage 请求上下文才有效）。
 */
async function loadHost(): Promise<HostModule> {
	const specifier = "emdash";
	return (await import(specifier)) as HostModule;
}

/** 发一次 Resend REST 请求；网络/解析异常统一收敛成 `{ ok:false }`。 */
export async function resendCall<T>(
	fetcher: Fetcher,
	config: ResendConfig,
	method: string,
	path: string,
	body?: unknown,
): Promise<ResendResult<T>> {
	try {
		const response = await fetcher(`${RESEND_ORIGIN}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${config.apiKey}`,
				"content-type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await response.text();
		if (!response.ok) {
			return { ok: false, status: response.status, error: summarizeError(response.status, text) };
		}
		return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
	} catch (error) {
		return { ok: false, status: 0, error: error instanceof Error ? error.name : "unknown" };
	}
}

/** 把 Resend 的错误响应压成一行（后台页直接展示）。 */
function summarizeError(status: number, text: string): string {
	const trimmed = text.trim().slice(0, 300);
	if (trimmed === "") return `http_${status}`;
	try {
		const parsed = JSON.parse(trimmed) as { message?: unknown; error?: unknown };
		const message = typeof parsed.message === "string" ? parsed.message : parsed.error;
		if (typeof message === "string" && message !== "") return `http_${status}: ${message}`;
	} catch {
		// 非 JSON：原样返回截断文本。
	}
	return `http_${status}: ${trimmed}`;
}

// ---------- Segments ----------

export interface ResendSegment {
	id: string;
	name: string;
}

export async function listSegments(fetcher: Fetcher, config: ResendConfig): Promise<ResendResult<ResendSegment[]>> {
	const result = await resendCall<{ data?: ResendSegment[] }>(fetcher, config, "GET", "/segments");
	if (!result.ok) return result;
	return { ok: true, data: Array.isArray(result.data.data) ? result.data.data : [] };
}

export async function createSegment(
	fetcher: Fetcher,
	config: ResendConfig,
	name: string,
): Promise<ResendResult<{ id: string }>> {
	return resendCall<{ id: string }>(fetcher, config, "POST", "/segments", { name });
}

/**
 * 按名字找到或创建 segment（幂等）。
 *
 * 先按名字在列表里找（分组数量天然很小），没有再创建 —— Resend 没有
 * 「按名字 upsert」的端点，而重复创建会得到两个同名 segment。
 */
export async function ensureSegment(
	fetcher: Fetcher,
	config: ResendConfig,
	name: string,
): Promise<ResendResult<ResendSegment>> {
	const listed = await listSegments(fetcher, config);
	if (!listed.ok) return listed;
	const existing = listed.data.find((segment) => segment.name === name);
	if (existing) return { ok: true, data: existing };

	const created = await createSegment(fetcher, config, name);
	if (!created.ok) return created;
	return { ok: true, data: { id: created.data.id, name } };
}

// ---------- Contacts ----------

export interface ContactInput {
	email: string;
	unsubscribed: boolean;
	/** 目标 segment id 列表（整体覆盖，不是增量）。 */
	segmentIds: string[];
}

/**
 * 建 / 改 contact。
 *
 * Resend 没有 contacts upsert：先 `POST /contacts`，撞「已存在」（409/422）再
 * `PATCH /contacts/{email}`（PATCH 接受 id 或 email）。两步都不抛错。
 */
export async function upsertContact(
	fetcher: Fetcher,
	config: ResendConfig,
	input: ContactInput,
): Promise<ResendResult<{ id?: string }>> {
	const segments = input.segmentIds.map((id) => ({ id }));
	const created = await resendCall<{ id?: string }>(fetcher, config, "POST", "/contacts", {
		email: input.email,
		unsubscribed: input.unsubscribed,
		segments,
	});
	if (created.ok) return created;
	if (created.status !== 409 && created.status !== 422) return created;

	return resendCall<{ id?: string }>(
		fetcher,
		config,
		"PATCH",
		`/contacts/${encodeURIComponent(input.email)}`,
		{ unsubscribed: input.unsubscribed, segments },
	);
}

export async function deleteContact(
	fetcher: Fetcher,
	config: ResendConfig,
	email: string,
): Promise<ResendResult<unknown>> {
	return resendCall(fetcher, config, "DELETE", `/contacts/${encodeURIComponent(email)}`);
}

// ---------- Broadcasts ----------

export interface BroadcastInput {
	segmentId: string;
	subject: string;
	html?: string;
	text?: string;
	/** 内部备注名。 */
	name?: string;
	replyTo?: string;
	/** `true` = 创建后立即发送。 */
	send: boolean;
}

export interface BroadcastSummary {
	id: string;
	status?: string;
	subject?: string;
	created_at?: string;
	scheduled_at?: string | null;
}

export async function createBroadcast(
	fetcher: Fetcher,
	config: ResendConfig,
	input: BroadcastInput,
): Promise<ResendResult<{ id: string }>> {
	return resendCall<{ id: string }>(fetcher, config, "POST", "/broadcasts", {
		segment_id: input.segmentId,
		from: config.fromAddress,
		subject: input.subject,
		...(input.html ? { html: input.html } : {}),
		...(input.text ? { text: input.text } : {}),
		...(input.name ? { name: input.name } : {}),
		...(input.replyTo ? { reply_to: input.replyTo } : {}),
		send: input.send,
	});
}

/** 发送已创建的草稿广播。 */
export async function sendBroadcast(
	fetcher: Fetcher,
	config: ResendConfig,
	broadcastId: string,
): Promise<ResendResult<unknown>> {
	return resendCall(fetcher, config, "POST", `/broadcasts/${encodeURIComponent(broadcastId)}/send`);
}

export async function listBroadcasts(
	fetcher: Fetcher,
	config: ResendConfig,
): Promise<ResendResult<BroadcastSummary[]>> {
	const result = await resendCall<{ data?: BroadcastSummary[] }>(fetcher, config, "GET", "/broadcasts");
	if (!result.ok) return result;
	return { ok: true, data: Array.isArray(result.data.data) ? result.data.data : [] };
}

// ---------- Webhook 验签（Svix）----------

export interface WebhookHeaders {
	id: string;
	timestamp: string;
	signature: string;
}

/** 默认容忍 5 分钟时钟偏差（Svix 建议）。 */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** 定时比较，避免逐字节提前返回泄露信息。 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * 校验 Resend（Svix）Webhook 签名。
 *
 * 签名对象是 `${svix-id}.${svix-timestamp}.${原始请求体}`；密钥是 `whsec_` 前缀
 * 的 base64；`svix-signature` 形如 `v1,<base64>`，可含多个以空格分隔的候选签名。
 *
 * `payload` 必须是**原始请求体字符串**（所以路由声明 `request: { body: "text" }`，
 * 不能让它先 JSON.parse 再 stringify —— 那样字节已变，验签必失败）。
 */
export async function verifyResendSignature(input: {
	payload: string;
	headers: WebhookHeaders;
	secret: string;
	now?: number;
	toleranceSeconds?: number;
}): Promise<boolean> {
	const { payload, headers, secret } = input;
	if (!headers.id || !headers.timestamp || !headers.signature || !secret) return false;

	const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
	const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
	const timestamp = Number.parseInt(headers.timestamp, 10);
	if (!Number.isFinite(timestamp)) return false;
	if (tolerance > 0 && Math.abs(nowSeconds - timestamp) > tolerance) return false;

	const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
	let keyBytes: Uint8Array<ArrayBuffer>;
	try {
		keyBytes = base64ToBytes(raw);
	} catch {
		return false;
	}

	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const signed = `${headers.id}.${headers.timestamp}.${payload}`;
	const digest = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)),
	);
	const expected = bytesToBase64(digest);

	return headers.signature
		.split(" ")
		.map((part) => part.trim())
		.filter(Boolean)
		.some((part) => {
			const [, value] = part.split(",");
			return typeof value === "string" && timingSafeEqual(value, expected);
		});
}

// ---------- Webhook 事件映射 ----------

export interface MappedResendEvent {
	/** 原样保留的 Resend 事件类型（`email.delivered` 等）。 */
	type: string;
	/** 收件人（`data.to` 的第一项）。 */
	email: string;
	broadcastId?: string;
	/** 退信 / 失败原因等。 */
	reason?: string;
}

function firstString(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return "";
}

/**
 * 把 Resend 的 Webhook 载荷映射成我们关心的字段。
 *
 * 形状（email 事件）：`{ type, created_at, data: { email_id, from, to, subject,
 * broadcast_id?, bounce?: { message } } }`。无法识别时返回 `null`。
 */
export function mapResendEvent(payload: unknown): MappedResendEvent | null {
	if (typeof payload !== "object" || payload === null) return null;
	const root = payload as Record<string, unknown>;
	const type = typeof root.type === "string" ? root.type : "";
	if (type === "") return null;

	const data = (typeof root.data === "object" && root.data !== null ? root.data : {}) as Record<
		string,
		unknown
	>;
	const email = firstString(data.to);
	const broadcastId = typeof data.broadcast_id === "string" ? data.broadcast_id : undefined;

	let reason: string | undefined;
	const bounce = data.bounce;
	if (typeof bounce === "object" && bounce !== null) {
		const message = (bounce as Record<string, unknown>).message;
		if (typeof message === "string") reason = message;
	}
	if (!reason && typeof data.failed === "object" && data.failed !== null) {
		const reasonText = (data.failed as Record<string, unknown>).reason;
		if (typeof reasonText === "string") reason = reasonText;
	}

	return { type, email, ...(broadcastId ? { broadcastId } : {}), ...(reason ? { reason } : {}) };
}
