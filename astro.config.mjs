import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import auditLog from "@emdash-cms/plugin-audit-log";
import emdash, { local } from "emdash/astro";
import { github } from "emdash/auth/providers/github";
import { sqlite } from "emdash/db";
import resend from "emdash-plugin-resend";
import pulseAgent from "pulse-agent";
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

const isCloudflare =
	process.env.DEPLOY_TARGET === "cloudflare" ||
	Boolean(process.env.CF_PAGES) ||
	Boolean(process.env.CLOUDFLARE);

// 插件一律在宿主进程内运行（`plugins: []`；标准格式插件由 emdash 的
// `adaptSandboxEntry` 适配，保留 hooks / routes / storage（含唯一索引）/
// adminPages / mcp.tools / 能力门禁）。
//
// 为什么不用沙箱（`sandboxed: []` + sandboxRunner）：
// - Cloudflare Workers 上唯一的沙箱后端是 Worker Loader（`LOADER` 绑定），需要
//   Workers 付费计划。免费计划下 `@emdash-cms/cloudflare` 的 `sandbox()` 读不到
//   绑定会返回 `undefined`，沙箱插件全部静默不加载（订阅 / 审核 / 投稿 / 主题切换
//   全失效，且构建期只打一条 warn）。
// - `sandbox: false` 这个本地逃生舱在 Workers 上被运行时显式禁用（emdash-runtime
//   抛 `sandbox: false is not supported in Cloudflare Workers`）。
// - 本项目插件全部自研，同进程运行的唯一代价是失去 isolate 隔离。
//
// 本地与生产走同一条路径（都 in-process），避免 dev/prod 行为分叉。
const plugins = [
	pulseReview,
	pulseEditorial,
	pulseAgent,
	pulseEditorApplications,
	pulseSubscriptions,
	pulseTheme,
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
// 本地 dev 放 `.env`；生产由 `scripts/deploy-cf.mjs` 用 `wrangler secret put` 写入。
const authProviders = [github()];

let adapter = node({ mode: "standalone" });
// Workers Cache：`cache` provider + `routeRules`（仅 CF 部署注入；Node 部署不引入 CF 包）。
// 命中时请求在 Worker 之前就被 Cloudflare 边缘返回 —— 完全不跑 SSR、不查 D1。
// 内容页已调用 `Astro.cache.set(cacheHint)`，响应会与集合 tag 关联，发布时由 EmDash purge。
// 注意：**只有** `astro.config` 配了 provider，`Astro.cache.enabled` 才为 true，页面里的
// `Astro.cache.set(...)` 才不是空操作。
let cacheConfig = {};
let emdashConfig = {
	database: sqlite({ url: "file:./data.db" }),
	storage: local({
		directory: "./uploads",
		baseUrl: "/_emdash/api/media/file",
	}),
	plugins,
	authProviders,
};

if (isCloudflare) {
	const { default: cloudflare } = await import("@astrojs/cloudflare");
	const { cacheCloudflare } = await import("@astrojs/cloudflare/cache");
	const { d1, r2 } = await import("@emdash-cms/cloudflare");
	const configPath = existsSync("wrangler.prod.jsonc") ? "wrangler.prod.jsonc" : "wrangler.jsonc";
	adapter = cloudflare({ configPath });
	cacheConfig = {
		cache: { provider: cacheCloudflare() },
		routeRules: {
			// 内容页（页面已调用 `Astro.cache.set`，与集合 tag 关联 → 发布时 purge）
			"/": { maxAge: 300, swr: 86400 },
			"/articles/[...path]": { maxAge: 300, swr: 86400 },
			"/sections/[...path]": { maxAge: 300, swr: 86400 },
			"/tags/[...path]": { maxAge: 300, swr: 86400 },
			"/editions/[...path]": { maxAge: 300, swr: 86400 },
			"/pages/[...path]": { maxAge: 600, swr: 86400 },
			"/archive": { maxAge: 600, swr: 86400 },
			"/archive/[...path]": { maxAge: 600, swr: 86400 },
			// 机器端点
			"/rss.xml": { maxAge: 300, swr: 86400 },
			"/feed.json": { maxAge: 300, swr: 86400 },
			"/llms.txt": { maxAge: 3600, swr: 86400 },
			"/robots.txt": { maxAge: 3600, swr: 86400 },
			"/sitemap.xml": { maxAge: 3600, swr: 86400 },
			"/sitemap-sections.xml": { maxAge: 3600, swr: 86400 },
			"/sitemap-tags.xml": { maxAge: 3600, swr: 86400 },
			// 会话 / 表单 / 错误页不在此列：`RouteRule` 不支持 headers，这些页面也不调用
			// `Astro.cache.set`，由 `src/middleware.ts` 统一设 `private, no-store`。
		},
	};
	emdashConfig = {
		// `session: "auto"` 让读走 D1 附近的副本；`coalesce: true` 把同一事件循环
		// 里的并发读合并成更少的 D1 往返（首页用 `Promise.all` 一次发 9+ 个查询，
		// 每个往返都有网络延迟）。coalesce 要求 session 非 "disabled"。
		// 注意：若改用 Targeted Placement 把 Worker 钉在 D1 primary 附近，官方建议
		// 反过来把 session 设回 "disabled"（两者不可兼得，见 docs/14）。
		database: d1({ binding: "DB", session: "auto", coalesce: true }),
		storage: r2({ binding: "MEDIA" }),
		plugins,
		authProviders,
	};
}

/**
 * 从 `EMDASH_SITE_URL`（部署时由 `npm run deploy:cf` 从 `wrangler.prod.jsonc`
 * 的 vars 传入构建）解析出生产 origin，加进 `image.remotePatterns`。
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

export default defineConfig({
	output: "server",
	adapter,
	...cacheConfig,
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
		],
	},
	integrations: [themeRoutes(), react(), emdash(emdashConfig)],
	devToolbar: { enabled: false },
	vite: {
		// 把构建期的默认主题烘进产物：中间件在 Node / Workers 两种运行时都能读到，
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
