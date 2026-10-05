import { existsSync } from "node:fs";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

const isCloudflare =
	process.env.DEPLOY_TARGET === "cloudflare" ||
	Boolean(process.env.CF_PAGES) ||
	Boolean(process.env.CLOUDFLARE);

let adapter = node({ mode: "standalone" });
let emdashConfig = {
	database: sqlite({ url: "file:./data.db" }),
	storage: local({
		directory: "./uploads",
		baseUrl: "/_emdash/api/media/file",
	}),
};

if (isCloudflare) {
	const { default: cloudflare } = await import("@astrojs/cloudflare");
	const { d1, r2 } = await import("@emdash-cms/cloudflare");
	const configPath = existsSync("wrangler.prod.jsonc") ? "wrangler.prod.jsonc" : "wrangler.jsonc";
	adapter = cloudflare({ configPath });
	emdashConfig = {
		database: d1({ binding: "DB", session: "auto" }),
		storage: r2({ binding: "MEDIA" }),
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
