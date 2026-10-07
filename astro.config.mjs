import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import auditLog from "@emdash-cms/plugin-audit-log";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import pulseAgent from "pulse-agent";
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

// 沙箱插件清单（本地与 Cloudflare 共用）
const sandboxedPlugins = [
	pulseReview,
	pulseEditorial,
	pulseAgent,
	pulseSubscriptions,
	pulseTheme,
	auditLog,
];

// 可信插件（in-process）。pulse-seo 只贡献 head 元数据，放宿主进程内可避免
// 每个公开页面渲染都起一次 isolate。
const trustedPlugins = [pulseSeo];

let adapter = node({ mode: "standalone" });
let emdashConfig = {
	database: sqlite({ url: "file:./data.db" }),
	storage: local({
		directory: "./uploads",
		baseUrl: "/_emdash/api/media/file",
	}),
	// 沙箱插件：本地 Node 用 workerd runner，Cloudflare 用 CF 的 sandbox runner。
	sandboxed: sandboxedPlugins,
	sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox",
	plugins: trustedPlugins,
};

if (isCloudflare) {
	const { default: cloudflare } = await import("@astrojs/cloudflare");
	const { d1, r2, sandbox } = await import("@emdash-cms/cloudflare");
	const configPath = existsSync("wrangler.prod.jsonc") ? "wrangler.prod.jsonc" : "wrangler.jsonc";
	adapter = cloudflare({ configPath });
	emdashConfig = {
		database: d1({ binding: "DB", session: "auto" }),
		storage: r2({ binding: "MEDIA" }),
		sandboxed: sandboxedPlugins,
		sandboxRunner: sandbox(),
		plugins: trustedPlugins,
	};
}

export default defineConfig({
	output: "server",
	adapter,
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
			{ protocol: "https", hostname: "ai.suda.im" },
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
