/**
 * Cloudflare 本地工具（`scripts/deploy-cf.mjs` 与 `scripts/demo-data.mjs` 共用）。
 *
 * 核心约定：仓库里不出现任何账号信息。账号目录、account id、token 全部来自本地
 * `.env.deploy`（已被 .gitignore 忽略）；本模块把它读出来，并把 `WRANGLER_HOME`
 * 作为子进程的 HOME，wrangler 因此使用该目录下已登录的凭据。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../..");

/** 读 KEY=VALUE 形式的 env 文件（不做 shell 展开，只去掉成对引号）。 */
export function parseEnvFile(file) {
	const out = {};
	if (!existsSync(file)) return out;
	for (const raw of readFileSync(file, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) out[key] = value;
	}
	return out;
}

/** 展开开头的 `~`（脚本里写 `~/.wrangler-x` 比写绝对路径更可移植）。 */
export function expandHome(value) {
	if (!value.startsWith("~")) return path.resolve(value);
	return path.resolve(homedir(), value.replace(/^~\/?/, ""));
}

/**
 * 从 wrangler 配置里取一个字符串字段。
 *
 * 不引 JSON 解析器：`.jsonc` 允许注释，而注释里很容易出现 `//`（URL），
 * 用「去注释再 parse」的土办法会误伤。这里只按 key 抓第一个字符串值。
 */
export function pickString(text, key) {
	const match = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
	return match ? match[1] : undefined;
}

/**
 * 读齐部署上下文。**不做校验**，由调用方决定缺什么时怎么报错。
 *
 * @returns {{
 *   root: string,
 *   deployEnv: Record<string,string>,
 *   localEnv: Record<string,string>,
 *   wranglerHome: string|undefined,   // 已展开 ~ 的绝对路径
 *   wranglerHomeRaw: string,
 *   configName: string,
 *   configPath: string,
 *   configExists: boolean,
 *   workerName?: string,
 *   databaseName?: string,
 *   bucketName?: string,
 *   siteUrl?: string,                 // wrangler 配置里的 EMDASH_SITE_URL
 *   wranglerBin: string,
 * }}
 */
export function loadCfContext() {
	const deployEnv = parseEnvFile(path.join(ROOT, ".env.deploy"));
	const localEnv = parseEnvFile(path.join(ROOT, ".env"));

	const wranglerHomeRaw = process.env.WRANGLER_HOME || deployEnv.WRANGLER_HOME || "";
	const wranglerHome = wranglerHomeRaw ? expandHome(wranglerHomeRaw) : undefined;

	const configName =
		process.env.WRANGLER_CONFIG || deployEnv.WRANGLER_CONFIG || "wrangler.prod.jsonc";
	const configPath = path.join(ROOT, configName);
	const configExists = existsSync(configPath);
	const configText = configExists ? readFileSync(configPath, "utf8") : "";

	const localWrangler = path.join(ROOT, "node_modules/.bin/wrangler");

	return {
		root: ROOT,
		deployEnv,
		localEnv,
		wranglerHome,
		wranglerHomeRaw,
		configName,
		configPath,
		configExists,
		workerName: pickString(configText, "name"),
		databaseName:
			process.env.D1_DATABASE || deployEnv.D1_DATABASE || pickString(configText, "database_name"),
		bucketName: pickString(configText, "bucket_name"),
		siteUrl: pickString(configText, "EMDASH_SITE_URL"),
		wranglerBin:
			process.env.WRANGLER_BIN ||
			deployEnv.WRANGLER_BIN ||
			(existsSync(localWrangler) ? localWrangler : "npx"),
	};
}

/** 缺少 `WRANGLER_HOME` 时的统一提示。 */
export const MISSING_WRANGLER_HOME = [
	"缺少 WRANGLER_HOME。",
	"",
	"  1. 复制模板：cp .env.deploy.example .env.deploy",
	"  2. 填入本地 Cloudflare 凭据目录（该目录下应已 `wrangler login`）",
	"",
	"仓库里刻意不写任何账号信息，所以这一步必须由本地文件提供。",
].join("\n");

/**
 * 造一个 wrangler 调用器：固定 HOME（目标账号）与 `-c <config>`。
 *
 * 显式传 `-c` 很关键 —— 否则 wrangler 可能被构建产物生成的
 * `.wrangler/deploy/config.json` 重定向到 `dist/server/wrangler.json`。
 */
export function createWrangler(ctx, { config = true } = {}) {
	const prefix = config ? ["-c", ctx.configName] : [];
	return (args, options = {}) =>
		runCommand(ctx.wranglerBin, [...(ctx.wranglerBin === "npx" ? ["wrangler"] : []), ...prefix, ...args], {
			env: { HOME: ctx.wranglerHome },
			...options,
		});
}

/** 跑一个子进程；capture 时返回 stdout/stderr，否则直接透传输出。 */
export function runCommand(command, args, { env, capture = false, input, allowFailure = false } = {}) {
	const result = spawnSync(command, args, {
		cwd: ROOT,
		env: { ...process.env, ...env },
		encoding: "utf8",
		...(input === undefined
			? { stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" }
			: { input, stdio: ["pipe", "inherit", "inherit"] }),
	});
	if (result.error) {
		return { ok: false, stdout: "", stderr: String(result.error), error: result.error };
	}
	return {
		ok: result.status === 0,
		status: result.status,
		stdout: (result.stdout ?? "").toString(),
		stderr: (result.stderr ?? "").toString(),
	};
}

/** 跑命令，失败即退出（带上下文）。 */
export function runOrDie(command, args, options = {}) {
	const result = runCommand(command, args, options);
	if (!result.ok) {
		const detail = `${result.stderr}${result.stdout}`.trim();
		throw new Error(`${command} ${args.join(" ")} 失败（退出码 ${result.status}）\n${detail}`);
	}
	return result;
}
