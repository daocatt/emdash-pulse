#!/usr/bin/env node
/**
 * Cloudflare 生产部署（账户无关）。
 *
 * 仓库里**不出现任何 Cloudflare 账号信息**：账号目录名、account id、token 全部
 * 落在本地 `.env.deploy`（已被 .gitignore 忽略），见 `scripts/lib/cf.mjs`。
 *
 * 真实 wrangler 配置同理：`wrangler.prod.jsonc`（被 `wrangler.*.jsonc` 忽略），
 * 由 `astro.config.mjs` 在 `DEPLOY_TARGET=cloudflare` 时优先读取。模板见
 * `wrangler.prod.jsonc.example`。
 *
 * 用法：
 *   npm run deploy:cf                    # 建桶 → 补 secret → 构建 → 部署
 *   npm run deploy:cf -- --skip-build    # 复用已有 dist，只部署
 *   npm run deploy:cf -- --no-secrets    # 不碰 secret
 *   npm run deploy:cf -- --no-buckets    # 不碰 R2 桶
 *
 * 前置：
 *   1. 复制 `.env.deploy.example` 为 `.env.deploy` 并填 `WRANGLER_HOME`
 *   2. 复制 `wrangler.prod.jsonc.example` 为 `wrangler.prod.jsonc` 并填真实值
 *   3. 该账号下已有 D1 库（脚本不建库，只建 R2 桶）
 */

import path from "node:path";
import {
	MISSING_WRANGLER_HOME,
	createWrangler,
	loadCfContext,
	runCommand,
	runOrDie,
} from "./lib/cf.mjs";

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);

const ctx = loadCfContext();

if (!ctx.wranglerHome) {
	console.error(`\n✘ ${MISSING_WRANGLER_HOME}\n`);
	process.exit(1);
}
if (!ctx.configExists) {
	console.error(
		[
			"",
			`✘ 找不到 ${ctx.configName}。`,
			"",
			`  1. 复制模板：cp wrangler.prod.jsonc.example ${ctx.configName}`,
			"  2. 填入 account_id 与真实的 D1 database_id",
			"",
			"`wrangler.*.jsonc` 已被 .gitignore 忽略，真实配置不会入库。",
			"",
		].join("\n"),
	);
	process.exit(1);
}

const wrangler = createWrangler(ctx);

console.log("Cloudflare 部署");
console.log(`  账号目录   ${ctx.wranglerHome.replace(process.env.HOME ?? "", "~")}`);
console.log(`  配置       ${ctx.configName}`);
console.log(`  Worker     ${ctx.workerName ?? "(未读到 name)"}`);
console.log(`  D1         ${ctx.databaseName ?? "(未读到 database_name)"}`);
console.log(`  R2         ${ctx.bucketName ?? "(未读到 bucket_name)"}`);
console.log(`  站点 URL   ${ctx.siteUrl ?? "(未读到 EMDASH_SITE_URL)"}`);
console.log();

// 1) 登录态自检（失败只警告：网络抖动很常见，真正失败会在后续步骤暴露）
if (!wrangler(["whoami"], { capture: true, allowFailure: true }).ok) {
	console.warn("⚠ 无法确认登录态（网络问题？），继续尝试后续步骤。\n");
}

// 2) R2 桶（幂等）
if (!hasFlag("--no-buckets")) {
	if (!ctx.bucketName) {
		console.warn("⚠ 配置里没有 bucket_name，跳过 R2 建桶。\n");
	} else {
		const created = wrangler(["r2", "bucket", "create", ctx.bucketName], {
			capture: true,
			allowFailure: true,
		});
		const output = `${created.stdout}${created.stderr}`;
		if (created.ok) {
			console.log(`✔ 已创建 R2 桶 ${ctx.bucketName}\n`);
		} else if (/already exists|10004/i.test(output)) {
			console.log(`✔ R2 桶 ${ctx.bucketName} 已存在\n`);
		} else {
			console.error(output.trim());
			console.error(`\n✘ 创建 R2 桶 ${ctx.bucketName} 失败。\n`);
			process.exit(1);
		}
	}
}

// 3) Secrets。只在缺失时写入 —— 覆盖已有值会让已加密落库的插件设置再也解不开，
//    也可能把线上已配好的 OAuth 凭据换掉。区分两类：
//    - 必需：缺了直接退出（EMDASH_ENCRYPTION_KEY）。
//    - 可选：本地没配就跳过、不阻断部署（GitHub OAuth 登录）。
if (!hasFlag("--no-secrets")) {
	const listed = wrangler(["secret", "list", "--format", "json"], {
		capture: true,
		allowFailure: true,
	});
	let names = [];
	if (listed.ok) {
		try {
			names = JSON.parse(listed.stdout).map((entry) => entry.name);
		} catch {
			names = [];
		}
	}

	const specs = [
		{
			name: "EMDASH_ENCRYPTION_KEY",
			required: true,
			missing: [
				"",
				"✘ Worker 缺少 EMDASH_ENCRYPTION_KEY，且本地 .env 里也没有。",
				"",
				"  生成：npx emdash secrets generate",
				"  写入：把结果填进 .env 的 EMDASH_ENCRYPTION_KEY",
				"",
				"⚠ 该密钥必须备份：换值后，之前加密落库的插件设置将无法解密。",
				"",
			].join("\n"),
		},
		{
			// GitHub 登录 provider 的凭证（见 astro.config.mjs 的 authProviders）。
			name: "EMDASH_OAUTH_GITHUB_CLIENT_ID",
			required: false,
			missing:
				"⚠ 未配置 EMDASH_OAUTH_GITHUB_CLIENT_ID，跳过 GitHub 登录（其余部署不受影响）。",
		},
		{
			name: "EMDASH_OAUTH_GITHUB_CLIENT_SECRET",
			required: false,
			missing:
				"⚠ 未配置 EMDASH_OAUTH_GITHUB_CLIENT_SECRET，跳过 GitHub 登录（其余部署不受影响）。",
		},
	];

	for (const spec of specs) {
		if (names.includes(spec.name)) {
			console.log(`✔ ${spec.name} 已存在，跳过`);
			continue;
		}
		const value = ctx.localEnv[spec.name] || process.env[spec.name];
		if (!value) {
			if (spec.required) {
				console.error(spec.missing);
				process.exit(1);
			}
			console.warn(spec.missing);
			continue;
		}
		runOrDie(
			ctx.wranglerBin,
			[
				...(ctx.wranglerBin === "npx" ? ["wrangler"] : []),
				"-c",
				ctx.configName,
				"secret",
				"put",
				spec.name,
			],
			{ env: { HOME: ctx.wranglerHome }, input: `${value}\n` },
		);
		console.log(`✔ 已写入 ${spec.name}`);
	}
	console.log();
}

// 4) 构建
if (hasFlag("--skip-build")) {
	console.log("⏭ 跳过构建（--skip-build）\n");
} else {
	console.log("→ 构建沙箱插件");
	runOrDie("npm", ["run", "plugin:build"]);

	console.log("\n→ 构建 Cloudflare 产物");
	// 把站点 origin 传给构建：`astro.config.mjs` 用它给 image.remotePatterns 补上
	// 生产域名（源码里不写死域名）。缺它时生产图片 srcset 会静默退回原图。
	const buildEnv = { DEPLOY_TARGET: "cloudflare" };
	if (ctx.siteUrl) {
		buildEnv.EMDASH_SITE_URL = ctx.siteUrl;
	} else {
		console.warn("⚠ 配置里没有 EMDASH_SITE_URL，构建将不含生产域名的图片白名单。");
	}
	runOrDie(path.join(ctx.root, "node_modules/.bin/astro"), ["build"], {
		env: buildEnv,
	});
	console.log();
}

// 5) 部署。
// 刻意不传 -c：adapter 已把产物配置写到 dist/server/wrangler.json，并由
// `.wrangler/deploy/config.json` 重定向，wrangler 会自动找到它。传 -c 反而会让它
// 去读 `main: ./src/worker.ts`（未构建的源码）。
console.log("→ 部署");
const deploy = runCommand(
	ctx.wranglerBin,
	ctx.wranglerBin === "npx" ? ["wrangler", "deploy"] : ["deploy"],
	{ env: { HOME: ctx.wranglerHome } },
);
if (!deploy.ok) {
	console.error("\n✘ 部署失败。\n");
	process.exit(1);
}

console.log("\n✔ 部署完成");
console.log("\n后续（首次部署）:");
console.log("  1. 打开 https://<域名>/_emdash/admin 走 setup 向导");
console.log("     —— 填站点标题/副标题 + 管理员邮箱 + 注册 Passkey；");
console.log("        向导会自动灌入 seed 内容与媒体（分批续跑，需要几分钟）。");
console.log("  2. 后台 → Resend 页 → 填 API key 与 From 地址（邮箱链接登录与订阅邮件依赖它）。");
console.log("  3. 灌 Demo 互动数据：npm run demo:data:remote");
console.log("  4. GitHub 登录（可选）：在 GitHub 新建 OAuth App，回调填");
console.log("     https://<域名>/_emdash/api/auth/oauth/github/callback，");
console.log("     把 Client ID/Secret 填进 .env 的 EMDASH_OAUTH_GITHUB_CLIENT_ID/_SECRET，");
console.log("     再跑一次 npm run deploy:cf（会补写这两个 secret）。");
