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

// ---------------------------------------------------------------------------
// 主题选择
//
// 两套主题（news-factory / pulse-news）都在仓库里，用 SITE_THEME 在构建期选一套，
// 一次只出一套。主题页面不是 src/pages 下的文件路由，而是通过下面的
// themeRoutes() integration 注入 —— 这样同一个 URL 在不同主题下可以指向不同实现。
//
// 新增人类页面时必须同时：① 在 THEME_ROUTES 注册；② 在两套主题里各放一份文件。
// ---------------------------------------------------------------------------
const THEME_NAMES = ["news-factory", "pulse-news"];
const SITE_THEME = process.env.SITE_THEME ?? "news-factory";
if (!THEME_NAMES.includes(SITE_THEME)) {
	throw new Error(
		`Unknown SITE_THEME="${SITE_THEME}"（可选：${THEME_NAMES.join(" / ")}）`,
	);
}
const themeDir = `src/themes/${SITE_THEME}`;

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
				for (const [pattern, rel] of THEME_ROUTES) {
					const entrypoint = `${themeDir}/${rel}`;
					if (!existsSync(fileURLToPath(new URL(entrypoint, import.meta.url)))) {
						throw new Error(
							`主题 "${SITE_THEME}" 缺少路由 ${pattern} 的页面：${entrypoint}`,
						);
					}
					injectRoute({ pattern, entrypoint });
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
const sandboxedPlugins = [pulseReview, pulseEditorial, pulseAgent, pulseSubscriptions, auditLog];

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
