/**
 * Redis 对象缓存后端（EmDash `objectCache` 的 entrypoint）。
 *
 * EmDash 通过 `virtual:emdash/object-cache` **静态 import** 本模块的
 * `createObjectCache`，并把 `astro.config.mjs` 里 `objectCache.config`
 * 序列化后传进来。由此有两条硬约束：
 *  1. 传进来的 config 必须是**可序列化**的（这里只用 `defaultTtl` / `keyPrefix`）；
 *  2. `REDIS_URL` 必须在**运行期**从 `process.env` 读 —— 写进 config 会被构建期
 *     固化进产物（见 astro.config.mjs 的说明）。
 *
 * 未配置 `REDIS_URL` 或连接失败时**降级为 no-op**（一律 miss）：缓存层对上层
 * 完全透明，只影响性能不影响正确性。
 */
import Redis from "ioredis";

/** EmDash `ObjectCacheRuntimeConfig` 的本地子集 + 允许透传的私有键。 */
export interface RedisObjectCacheConfig {
	/** 连接串；缺省时读运行期 `REDIS_URL`。 */
	url?: string;
	/** 键前缀；缺省 `pulse`。 */
	keyPrefix?: string;
	/** 默认 TTL（秒）；缺省 3600。 */
	defaultTtl?: number;
	[key: string]: unknown;
}

/** 与 EmDash `ObjectCacheBackend` 对齐（避免直接依赖其内部类型）。 */
export interface ObjectCacheBackend {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ttlSeconds?: number): Promise<void>;
	delete(key: string): Promise<void>;
}

/** 直通后端：所有读都 miss，写/删为空操作。 */
const NOOP_BACKEND: ObjectCacheBackend = {
	async get() {
		return null;
	},
	async set() {
		/* no-op */
	},
	async delete() {
		/* no-op */
	},
};

export function createObjectCache(config: RedisObjectCacheConfig = {}): ObjectCacheBackend {
	const url = (config.url as string | undefined) ?? process.env.REDIS_URL;
	if (!url) {
		console.warn("[redis-cache] REDIS_URL 未设置，对象缓存降级为直通（无缓存）");
		return NOOP_BACKEND;
	}

	const prefix = config.keyPrefix ?? "pulse";
	const defaultTtl = typeof config.defaultTtl === "number" ? config.defaultTtl : 3600;

	// 懒连接：首个命令才建连；连不上时命令按 maxRetriesPerRequest 快速失败，
	// 由下面的 try/catch 降级为 miss（EmDash 读取侧另有 2s 超时兜底）。
	const client = new Redis(url, {
		lazyConnect: true,
		maxRetriesPerRequest: 1,
		connectTimeout: 2000,
		retryStrategy: (times) => Math.min(times * 200, 2000),
	});

	// ioredis 在连接失败时会持续重试并 emit "error"；只提示一次，避免刷屏。
	let warned = false;
	client.on("error", (error: unknown) => {
		if (warned) return;
		warned = true;
		console.warn(
			`[redis-cache] ${error instanceof Error ? error.message : String(error)}；对象缓存降级为直通`,
		);
	});

	const namespaced = (key: string) => `${prefix}:${key}`;

	return {
		async get(key) {
			try {
				return await client.get(namespaced(key));
			} catch {
				return null;
			}
		},
		async set(key, value, ttlSeconds) {
			try {
				const ttl = ttlSeconds ?? defaultTtl;
				if (ttl > 0) await client.set(namespaced(key), value, "EX", ttl);
				else await client.set(namespaced(key), value);
			} catch {
				/* 缓存写失败不影响请求 */
			}
		},
		async delete(key) {
			try {
				await client.del(namespaced(key));
			} catch {
				/* no-op */
			}
		},
	};
}

export default createObjectCache;
