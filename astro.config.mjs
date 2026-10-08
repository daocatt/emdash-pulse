import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig, sessionDrivers } from "astro/config";
import auditLog from "@emdash-cms/plugin-audit-log";
import emdash, { local, s3 } from "emdash/astro";
import { github } from "emdash/auth/providers/github";
import { postgres } from "emdash/db";
import resend from "emdash-plugin-resend";
import pulseAgent from "pulse-agent";
import pulseAi from "pulse-ai";
import pulseEditorApplications from "pulse-editor-applications";
import pulseEditorial from "pulse-editorial";
import pulseReview from "pulse-review";
import pulseSeo from "pulse-seo";
import pulseSubscriptions from "pulse-subscriptions";
import pulseTheme from "pulse-theme";

// ---------------------------------------------------------------------------
// 主题路由
//
// 两套主题（news-factory / pulse-news）都在仓库里。**默认主题**（SITE_THEME）按干净
// 路径注册，另一套注册在带前缀的 `/_t/<theme>/…` 下；运行期由
// `src/middleware.ts` 读后台「前台主题」页写的插件设置（`pulse-theme:theme`），
// 需要时把干净路径 rewrite 到前缀。
//
// 为什么默认主题留在干净路径上：
// - EmDash 的中间件跑在我们前面，看到的始终是原始路径（`locals.emdash.db` 注入、
//   redirect 命中、404 记账都与今天一致）；
// - 只有干净路径能命中路由，中间件才能用 `routePattern === "/404"` 区分
//   「真 404」与「正常页面」，否则所有页面都会被当成 404。
//
// 主题页面不是 src/pages 下的文件路由，而是通过下面的 themeRoutes() integration 注入
// —— 这样同一个 URL 在不同主题下可以指向不同实现。
//
// 新增人类页面时必须同时：① 在 THEME_ROUTES 注册；② 在两套主题里各放一份文件。
// ---------------------------------------------------------------------------
const THEME_NAMES = ["news-factory", "pulse-news"];
const DEFAULT_SITE_THEME = process.env.SITE_THEME ?? "news-factory";
if (!THEME_NAMES.includes(DEFAULT_SITE_THEME)) {
	throw new Error(
		`Unknown SITE_THEME="${DEFAULT_SITE_THEME}"（可选：${THEME_NAMES.join(" / ")}）`,
	);
}
/** 非默认主题的内部路由前缀；直接访问会被中间件 302 回干净路径。 */
const THEME_PREFIX = "/_t";

// 人类页面路由表（机器端点仍在 src/pages/*.ts，主题无关）
const THEME_ROUTES = [
	["/", "pages/index.astro"],
	["/articles/[slug]", "pages/articles/[slug].astro"],
	["/sections/[slug]", "pages/sections/[slug].astro"],
	["/tags/[slug]", "pages/tags/[slug].astro"],
	["/archive", "pages/archive/index.astro"],
	["/archive/[year]/[month]", "pages/archive/[year]/[month].astro"],
	["/archive/[year]/week/[week]", "pages/archive/[year]/week/[week].astro"],
	["/editions/[slug]", "pages/editions/[slug].astro"],
	["/pages/[slug]", "pages/pages/[slug].astro"],
	["/search", "pages/search.astro"],
	["/subscribe", "pages/subscribe.astro"],
	["/subscribe/confirm", "pages/subscribe/confirm.astro"],
	["/subscribe/unsubscribe", "pages/subscribe/unsubscribe.astro"],
	["/editor/apply", "pages/editor/apply.astro"],
	["/404", "pages/404.astro"],
];

function themeRoutes() {
	return {
		name: "suda-pulse:theme-routes",
		hooks: {
			"astro:config:setup": ({ injectRoute }) => {
				for (const name of THEME_NAMES) {
					// 默认主题走干净路径；其余主题走 /_t/<name>/…（中间件按运行期设置 rewrite）。
					const prefix = name === DEFAULT_SITE_THEME ? "" : `${THEME_PREFIX}/${name}`;
					for (const [pattern, rel] of THEME_ROUTES) {
						const entrypoint = `src/themes/${name}/${rel}`;
						if (!existsSync(fileURLToPath(new URL(entrypoint, import.meta.url)))) {
							throw new Error(
								`主题 "${name}" 缺少路由 ${pattern} 的页面：${entrypoint}`,
							);
						}
						injectRoute({ pattern: `${prefix}${pattern}`, entrypoint });
					}
				}
			},
		},
	};
}

// 插件一律在宿主进程内运行（`plugins: []`；标准格式插件由 emdash 的
// `adaptSandboxEntry` 适配，保留 hooks / routes / storage（含唯一索引）/
// adminPages / mcp.tools / 能力门禁）。
//
// 为什么不用沙箱（`sandboxed: []` + sandboxRunner）：
// - Node 部署下沙箱后端是 `@emdash-cms/sandbox-workerd`（workerd 子进程），
//   对一套全部自研的插件没有收益，反而引入子进程启动与失败模式。
// - 本项目插件全部自研，同进程运行的唯一代价是失去 isolate 隔离。
const plugins = [
	pulseReview,
	pulseEditorial,
	pulseAgent,
	pulseEditorApplications,
	pulseSubscriptions,
	pulseTheme,
	// pulse-ai：AI 接入配置（Cloudflare AI Gateway / 多 provider）。消费方
	// （pulse-review 的评论审核）通过 `pulse-ai/client` 同进程 import 使用。
	pulseAi,
	auditLog,
	// pulse-seo 只贡献 head 元数据，放宿主进程内可避免每个公开页面渲染都起一次 isolate。
	pulseSeo,
	// emdash-plugin-resend 是独占 `email:deliver` 的邮件 provider：没有它，生产环境的
	// 邮箱链接登录（magic link）会直接 503 `EMAIL_NOT_CONFIGURED`，`pulse-subscriptions`
	// 的确认/欢迎信也只能落 `pendingEmail`。它只需要出网到 `api.resend.com`，同进程即可，
	// 不必为一个 provider 起 isolate（唯一 active provider 会被自动选中，见
	// resolveExclusiveHooks）。API key 与 From 地址在后台「Resend」页填写。
	resend(),
];

// 登录 provider：**加法**，与内建 passkey 并存（不同于 `auth` 适配器会顶掉 passkey）。
// GitHub 让第三方用户自助注册（Subscriber）→ 到申请页申请成为 Editor（见
// plugins/pulse-editor-applications）。凭证走环境变量，EmDash 优先读带前缀的名字：
//   EMDASH_OAUTH_GITHUB_CLIENT_ID / EMDASH_OAUTH_GITHUB_CLIENT_SECRET
// GitHub OAuth App 的回调地址填：https://<站点域名>/_emdash/api/auth/oauth/github/callback
// 本地 dev 放 `.env`；生产由容器 / 宿主的进程环境注入（见 docker-compose.yml）。
const authProviders = [github()];

const adapter = node({ mode: "standalone" });

// ---------------------------------------------------------------------------
// 数据库 / 存储 / 缓存
//
// EmDash 把 `database`/`storage` 描述符 JSON 序列化进 `virtual:emdash/config`，
// **构建期就固化进产物**。所以这里绝不写 `process.env.DATABASE_URL` 这类字面值
// —— 否则连接串会被烘进镜像。正确做法是「构建期只选种类，凭据运行期读 env」：
//
//   - PostgreSQL：`postgres()` 不带 connectionString，运行期由 `pg` 连接池读标准
//     libpq 变量（PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD）；迁移工具
//     另读 `DATABASE_URL`（两者指向同一库，见 docker-compose.yml）。
//   - 存储：构建期只决定 `s3()` 还是 `local()`；s3() 的凭据运行期由
//     `resolveS3Config` 从 `S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / ...` 补齐。
//   - 对象缓存：Redis 后端运行期读 `REDIS_URL`；未设置时降级为 no-op（缓存直通）。
// ---------------------------------------------------------------------------
const database = postgres({
	// 连接信息全部走运行期 env（见上）。连接池大小可单独调。
	pool: { min: 2, max: 10, connectionTimeoutMillis: 5000 },
});

// 构建期开关：`S3_ENDPOINT` 存在即用 s3()（R2 / MinIO / 任意 S3 兼容），
// 否则回退本地磁盘（本地开发 / 单机无对象存储）。只决定种类，不读凭据。
const storage = process.env.S3_ENDPOINT
	? s3()
	: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" });

// Redis 对象缓存后端（自研，`src/server/redis-object-cache.ts`）。
// entrypoint 用**绝对路径**：它会被原样内联进虚拟模块的静态 import，
// 绝对路径可被 Vite / Rollup 直接解析，避免相对路径在虚拟模块里解析错位。
const objectCacheEntrypoint = fileURLToPath(
	new URL("./src/server/redis-object-cache.ts", import.meta.url),
);

const emdashConfig = {
	database,
	storage,
	objectCache: {
		entrypoint: objectCacheEntrypoint,
		// 只放可序列化的默认值；`REDIS_URL` 由后端在运行期读取。
		config: { defaultTtl: 3600, keyPrefix: "pulse" },
	},
	plugins,
	authProviders,
};

/**
 * 从 `EMDASH_SITE_URL`（部署时注入）解析出站点 origin，加进 `image.remotePatterns`。
 *
 * 这样源码里**不写死任何站点域名**：换域名只改部署配置即可，无需动这里。
 * 没设时只保留本地 origin（本地开发用）。
 */
function siteOriginPattern() {
	const raw = process.env.EMDASH_SITE_URL || process.env.SITE_URL;
	if (!raw) return [];
	try {
		const url = new URL(raw);
		return [{ protocol: url.protocol.replace(":", ""), hostname: url.hostname }];
	} catch {
		return [];
	}
}

/**
 * S3 / R2 的公开域（`S3_PUBLIC_URL`）也要进 `remotePatterns`：配了 publicUrl 时
 * 媒体 URL 直接指向它（CDN / R2 自定义域），`<Image>` 会对该 origin 取图做变换，
 * 未授权则生产构建静默退回原图。构建期读一次即可（域名不是秘密）。
 */
function s3PublicOriginPattern() {
	const raw = process.env.S3_PUBLIC_URL;
	if (!raw) return [];
	try {
		const url = new URL(raw);
		return [{ protocol: url.protocol.replace(":", ""), hostname: url.hostname }];
	} catch {
		return [];
	}
}

export default defineConfig({
	output: "server",
	adapter,
	// 会话：Node 默认是 fsLite（写在 cacheDir 下）。显式指到 `./data/sessions`，
	// 这样容器里挂 `./data` 卷即可持久化会话（单实例足够；多实例再换 Redis driver）。
	// 这里只写路径（不是秘密），不涉及构建期固化凭据的问题。
	session: { driver: sessionDrivers.fsLite({ base: "./data/sessions" }) },
	image: {
		layout: "constrained",
		responsiveStyles: true,
		// EmDash 的 `<Image>` 把同源媒体路径（`/_emdash/api/media/file/...`）
		// 解析成绝对 URL 后交给 Astro 的 image service 生成 srcset。Astro 只对
		// 绝对 http(s) URL 做变换，且要求 origin 在 remotePatterns 白名单内，
		// 否则生产环境会静默退回原图（srcset 各档位指向同一张全尺寸图）。
		remotePatterns: [
			{ protocol: "http", hostname: "localhost" },
			{ protocol: "http", hostname: "127.0.0.1" },
			...siteOriginPattern(),
			...s3PublicOriginPattern(),
		],
	},
	integrations: [themeRoutes(), react(), emdash(emdashConfig)],
	devToolbar: { enabled: false },
	vite: {
		// 把构建期的默认主题烘进产物：中间件在 Node 运行时读到，
		// 不依赖 process.env（Workers 上 process.env 只映射 wrangler 的 vars）。
		define: {
			__DEFAULT_SITE_THEME__: JSON.stringify(DEFAULT_SITE_THEME),
		},
		optimizeDeps: {
			// `motion/mini` 只被**动态** import 的 `src/scripts/motion/runtime.ts` 引用。
			// 不预构建的话，Vite 可能在首次动态 import 时才把它当新依赖去优化，重新
			// 生成 browserHash → 那一发请求拿到 `504 Outdated Optimize Dep`，整条
			// 动效运行时静默失效（`boot.ts` 的 catch 只打一条 warn）。写进 include
			// 让它在冷启动的第一次扫描里就进预构建，哈希从开始就是稳定的。
			include: ["motion/mini"],
		},
		resolve: {
			// 主题页面跨目录引用共享层用别名，避免随页面深度变化的 ../ 前缀。
			alias: {
				"@shared": fileURLToPath(new URL("./src/components", import.meta.url)),
				"@utils": fileURLToPath(new URL("./src/utils", import.meta.url)),
			},
		},
		server: {
			watch: {
				// 上传的媒体是运行时数据，不属于源码：否则每次上传都会触发
				// dev server 重启，正在进行的请求会被打断（如 seed-local-media）。
				ignored: ["**/uploads/**"],
			},
		},
	},
});
