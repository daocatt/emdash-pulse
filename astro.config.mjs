import { existsSync } from "node:fs";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import auditLog from "@emdash-cms/plugin-audit-log";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import pulseReview from "pulse-review";

const isCloudflare =
	process.env.DEPLOY_TARGET === "cloudflare" ||
	Boolean(process.env.CF_PAGES) ||
	Boolean(process.env.CLOUDFLARE);

// 沙箱插件清单（本地与 Cloudflare 共用）
const sandboxedPlugins = [pulseReview, auditLog];

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
	};
}

export default defineConfig({
	output: "server",
	adapter,
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [react(), emdash(emdashConfig)],
	devToolbar: { enabled: false },
});
