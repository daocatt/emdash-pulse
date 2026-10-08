/**
 * 轻量限流（Agent Read API 公开端点用）。
 *
 * 实现为模块级滑动窗口计数：进程内、按 key（通常为 IP）。这是**尽力而为**的
 * 限流 —— 单实例部署下即全局计数；水平扩展（多进程）时每个进程各持一份，
 * 无法全局精确。需要跨实例精确配额时可换成 Redis（`REDIS_URL` 已就绪）。
 *
 * 预留 API key 升级路径：调用方可传 `key`（如 token 前缀）以获得独立配额。
 */

interface Bucket {
	windowStart: number;
	count: number;
}

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 5000;

export interface RateLimitOptions {
	/** 窗口内允许的请求数。 */
	limit?: number;
	/** 窗口长度（毫秒）。 */
	windowMs?: number;
}

export interface RateLimitResult {
	ok: boolean;
	remaining: number;
	retryAfterSeconds: number;
}

export function checkRateLimit(key: string, options: RateLimitOptions = {}): RateLimitResult {
	const limit = options.limit ?? 120;
	const windowMs = options.windowMs ?? 60_000;
	const now = Date.now();

	if (buckets.size > MAX_KEYS) buckets.clear();

	const bucket = buckets.get(key);
	if (!bucket || now - bucket.windowStart >= windowMs) {
		buckets.set(key, { windowStart: now, count: 1 });
		return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
	}

	bucket.count += 1;
	if (bucket.count > limit) {
		const retryAfterSeconds = Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000));
		return { ok: false, remaining: 0, retryAfterSeconds };
	}
	return { ok: true, remaining: limit - bucket.count, retryAfterSeconds: 0 };
}

/** 从请求头推断客户端标识（反代下用 `x-forwarded-for`；保留 `cf-connecting-ip` 兼容）。 */
export function clientKey(request: Request): string {
	const headers = request.headers;
	return (
		headers.get("cf-connecting-ip") ??
		headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		headers.get("x-real-ip") ??
		"unknown"
	);
}

/** 统一的 429 响应。 */
export function tooManyRequests(retryAfterSeconds: number): Response {
	return new Response(JSON.stringify({ error: "RATE_LIMITED", retry_after_seconds: retryAfterSeconds }), {
		status: 429,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Retry-After": String(retryAfterSeconds),
			"Access-Control-Allow-Origin": "*",
		},
	});
}
