import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit, clientIp } from "../src/rate-limit";

/** 最小 kv 桩：只实现 `get`/`set`，值存 Map，便于断言键的数量与形状。 */
function fakeCtx() {
	const store = new Map<string, unknown>();
	return {
		store,
		ctx: {
			kv: {
				get: async <T>(key: string): Promise<T | null> =>
					store.has(key) ? (store.get(key) as T) : null,
				set: async (key: string, value: unknown): Promise<void> => {
					store.set(key, value);
				},
			},
		} as never,
	};
}

const T0 = new Date("2026-10-06T00:00:00.000Z");

describe("checkRateLimit", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("窗口内放行 limit 次，第 limit+1 次拒绝并给出 retryAfter", async () => {
		const { ctx } = fakeCtx();
		for (let i = 0; i < 3; i += 1) {
			const r = await checkRateLimit(ctx, "route:1.2.3.4", 3, 60);
			expect(r.allowed).toBe(true);
			expect(r.remaining).toBe(2 - i);
		}
		const blocked = await checkRateLimit(ctx, "route:1.2.3.4", 3, 60);
		expect(blocked.allowed).toBe(false);
		expect(blocked.remaining).toBe(0);
		expect(blocked.retryAfter).toBe(60);
	});

	it("窗口过期后原地重置，始终只占一个键（无界增长回归）", async () => {
		const { ctx, store } = fakeCtx();
		await checkRateLimit(ctx, "route:1.2.3.4", 1, 60);
		expect((await checkRateLimit(ctx, "route:1.2.3.4", 1, 60)).allowed).toBe(false);

		// 跨过 3 个窗口：每次都重新放行，但键不新增（旧实现会按时间桶建 3 个新键）。
		for (let i = 0; i < 3; i += 1) {
			vi.advanceTimersByTime(60_000);
			expect((await checkRateLimit(ctx, "route:1.2.3.4", 1, 60)).allowed).toBe(true);
		}
		expect(store.size).toBe(1);
		expect([...store.keys()]).toEqual(["rl:route:1.2.3.4"]);
	});

	it("窗口锚定首次请求，窗口内不因跨越整点而双倍放行", async () => {
		const { ctx } = fakeCtx();
		// T0 是整点；若按 epoch 对齐分桶，T0+59s 仍属同一桶。
		await checkRateLimit(ctx, "route:a", 2, 60);
		vi.advanceTimersByTime(59_000);
		expect((await checkRateLimit(ctx, "route:a", 2, 60)).allowed).toBe(true);
		expect((await checkRateLimit(ctx, "route:a", 2, 60)).allowed).toBe(false);
		expect((await checkRateLimit(ctx, "route:a", 2, 60)).retryAfter).toBe(1);
	});

	it("不同客户端互不影响", async () => {
		const { ctx } = fakeCtx();
		await checkRateLimit(ctx, "route:a", 1, 60);
		expect((await checkRateLimit(ctx, "route:a", 1, 60)).allowed).toBe(false);
		expect((await checkRateLimit(ctx, "route:b", 1, 60)).allowed).toBe(true);
	});
});

describe("clientIp", () => {
	it("取 meta.ip，缺失时回退 unknown", () => {
		expect(clientIp({ ip: "1.2.3.4" })).toBe("1.2.3.4");
		expect(clientIp({ ip: null })).toBe("unknown");
		expect(clientIp({ ip: "" })).toBe("unknown");
		expect(clientIp(null)).toBe("unknown");
		expect(clientIp("nope")).toBe("unknown");
	});
});
