#!/usr/bin/env node
/**
 * 移动端性能复核（Lighthouse，本地构建 + 运行期主题切换）。
 *
 * 为什么不用 `astro preview`：本地 adapter 是 `@astrojs/node` standalone，
 * 构建产物 `dist/server/entry.mjs` 可直接跑，DB 是文件 SQLite、存储是 `./uploads`，
 * 不依赖 Cloudflare 绑定。一次构建即含两套主题（`themeRoutes()` 都注入了），
 * 所以切主题只需改运行期设置（`options` 表的 `plugin:pulse-theme:settings:theme`），
 * 不必为每套主题各构建一次。
 *
 * 用法：
 *   npm run perf                       # 构建 + 两套主题 × 代表路由
 *   npm run perf -- --no-build         # 复用现有 dist
 *   npm run perf -- --theme=pulse-news --route=/ --route=/archive
 *   npm run perf -- --runs=3           # 每个采样点跑 3 次取中位数（抗方差）
 *   npm run perf -- --json             # 机器可读输出
 *
 * 环境变量：
 *   CHROME_PATH   自定义 Chrome 可执行文件（默认 macOS 系统 Chrome）
 *
 * 退出码：任一指标超阈值 → 1。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { launch } from "chrome-launcher";
import lighthouse from "lighthouse";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = resolve(ROOT, "data.db");
const ENTRY = resolve(ROOT, "dist/server/entry.mjs");
const THEME_KEY = "plugin:pulse-theme:settings:theme";
const THEMES = ["news-factory", "pulse-news"];

/**
 * 移动端阈值表。`min` 是下限，`max` 是上限；任一越界即失败。
 * 阈值取 Lighthouse 移动端「良好」区间（LCP ≤ 2.5s / CLS ≤ 0.1 / TBT ≤ 200ms / 分数 ≥ 0.9）。
 */
const CHECKS = [
	{ key: "score", label: "Perf", unit: "", min: 0.9, decimals: 2 },
	{ key: "lcp", label: "LCP", unit: "ms", max: 2500, decimals: 0 },
	{ key: "cls", label: "CLS", unit: "", max: 0.1, decimals: 3 },
	{ key: "tbt", label: "TBT", unit: "ms", max: 200, decimals: 0 },
];

function log(msg) {
	console.log(`[perf] ${msg}`);
}

function parseArgs(argv) {
	const opts = { noBuild: false, json: false, runs: 1, themes: [], routes: [] };
	for (const arg of argv) {
		if (arg === "--no-build") opts.noBuild = true;
		else if (arg === "--json") opts.json = true;
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else if (arg.startsWith("--runs=")) {
			opts.runs = Math.max(1, Number.parseInt(arg.slice(7), 10) || 1);
		} else if (arg.startsWith("--theme=")) {
			opts.themes.push(...arg.slice(8).split(",").filter(Boolean));
		} else if (arg.startsWith("--route=")) {
			opts.routes.push(...arg.slice(8).split(",").filter(Boolean));
		} else {
			throw new Error(`未知参数: ${arg}（--help 查看用法）`);
		}
	}
	if (opts.themes.length === 0) opts.themes = [...THEMES];
	for (const theme of opts.themes) {
		if (!THEMES.includes(theme)) throw new Error(`未知主题: ${theme}（可选 ${THEMES.join(" / ")}）`);
	}
	return opts;
}

function printHelp() {
	console.log(`用法: npm run perf -- [选项]

  --no-build          跳过构建，复用现有 dist/
  --theme=<a,b>       只测指定主题（默认两套都测）
  --route=<path,path> 只测指定路由（默认自动发现）
  --runs=N            每个采样点重复 N 次取中位数（默认 1）
  --json              输出机器可读 JSON（不打印表格）
  -h, --help          显示本帮助`);
}

/** 让内核挑一个空闲端口。 */
function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolvePort(port));
		});
	});
}

function runBuild() {
	log("构建（含两套主题）…");
	return new Promise((resolveBuild, reject) => {
		const child = spawn("npm", ["run", "build:news-factory"], { cwd: ROOT, stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolveBuild() : reject(new Error(`构建失败（退出码 ${code}）`))));
	});
}

function startServer(port) {
	const child = spawn(process.execPath, [ENTRY], {
		cwd: ROOT,
		env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	child.getOutput = () => output;
	return child;
}

/**
 * 关掉构建产物服务器。
 *
 * `@astrojs/node` 的 standalone 服务器**不响应 SIGTERM**（进程会一直活着），
 * 只发 SIGTERM 会让父进程因为子进程的 stdio 管道未关而永久挂起 —— 所以这里
 * 先 SIGTERM 给个机会优雅退出，超时后补 SIGKILL，并主动销毁管道。
 */
async function stopServer(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	child.stdout?.destroy();
	child.stderr?.destroy();
	child.kill("SIGTERM");
	const exited = await Promise.race([
		new Promise((resolve) => child.once("exit", () => resolve(true))),
		delay(1500).then(() => false),
	]);
	if (!exited) child.kill("SIGKILL");
}

async function fetchText(url) {
	const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
	if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${url}`);
	return res.text();
}

async function waitForReady(origin, timeoutMs = 60000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			await fetchText(`${origin}/`);
			return;
		} catch (error) {
			lastError = error;
			await delay(300);
		}
	}
	throw new Error(`服务器未在 ${timeoutMs}ms 内就绪: ${lastError?.message}`);
}

/** 不硬编码 slug：从 sitemap 索引 → 子 sitemap → 第一条 `<loc>`。 */
async function discoverRoutes(origin) {
	const routes = ["/", "/archive"];
	const index = await fetchText(`${origin}/sitemap.xml`);
	const subSitemaps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
	for (const wanted of ["articles", "editions", "sections"]) {
		const sub = subSitemaps.find((url) => url.includes(`sitemap-${wanted}.xml`));
		if (!sub) continue;
		const xml = await fetchText(sub);
		const first = xml.match(/<loc>([^<]+)<\/loc>/)?.[1];
		if (first) routes.push(new URL(first).pathname);
	}
	return [...new Set(routes)];
}

/** 预热：把路由走两遍，让渲染缓存 / 连接池就位，降低首测偏差。 */
async function warmup(origin, routes) {
	for (let pass = 0; pass < 2; pass += 1) {
		for (const route of routes) {
			try {
				await fetchText(`${origin}${route}`);
			} catch {
				// 预热失败不致命，留给 Lighthouse 报错
			}
		}
	}
}

function readTheme(db) {
	const row = db.prepare("SELECT value FROM options WHERE name = ?").get(THEME_KEY);
	if (!row) return null;
	try {
		return JSON.parse(row.value);
	} catch {
		return row.value;
	}
}

function setTheme(db, theme) {
	db.prepare(
		`INSERT INTO options (name, value, revision) VALUES (?, ?, '0')
		 ON CONFLICT(name) DO UPDATE SET value = excluded.value, revision = '0'`,
	).run(THEME_KEY, JSON.stringify(theme));
}

/** 写入后回读页面确认生效（`getPluginSetting` 无跨请求缓存，通常下一次请求即生效）。 */
async function applyTheme(db, origin, theme) {
	setTheme(db, theme);
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const html = await fetchText(`${origin}/`);
		if (html.includes(`data-site-theme="${theme}"`)) return;
		await delay(150);
	}
	throw new Error(`主题切换未生效: ${theme}`);
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function sampleOnce(port, url) {
	const result = await lighthouse(url, {
		port,
		output: "json",
		logLevel: "error",
		onlyCategories: ["performance"],
		formFactor: "mobile",
		screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
	});
	const { lhr } = result;
	return {
		score: lhr.categories.performance.score,
		lcp: lhr.audits["largest-contentful-paint"].numericValue,
		cls: lhr.audits["cumulative-layout-shift"].numericValue,
		tbt: lhr.audits["total-blocking-time"].numericValue,
	};
}

async function measure(port, url, runs) {
	const samples = [];
	for (let i = 0; i < runs; i += 1) samples.push(await sampleOnce(port, url));
	const keys = ["score", "lcp", "cls", "tbt"];
	const out = {};
	for (const key of keys) out[key] = median(samples.map((sample) => sample[key]));
	return out;
}

function chromePath() {
	if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
	const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	return existsSync(mac) ? mac : undefined;
}

function formatValue(value, decimals) {
	return Number.isFinite(value) ? value.toFixed(decimals) : "n/a";
}

function evaluate(results) {
	const failures = [];
	for (const row of results) {
		if (row.error) {
			failures.push({ theme: row.theme, route: row.route, label: "ERROR", detail: row.error });
			continue;
		}
		for (const check of CHECKS) {
			const value = row[check.key];
			if (!Number.isFinite(value)) {
				failures.push({ theme: row.theme, route: row.route, label: check.label, detail: "无数据" });
				continue;
			}
			if (check.max != null && value > check.max) {
				failures.push({
					theme: row.theme,
					route: row.route,
					label: check.label,
					detail: `${formatValue(value, check.decimals)} > ${check.max}${check.unit}`,
				});
			}
			if (check.min != null && value < check.min) {
				failures.push({
					theme: row.theme,
					route: row.route,
					label: check.label,
					detail: `${formatValue(value, check.decimals)} < ${check.min}${check.unit}`,
				});
			}
		}
	}
	return failures;
}

function printTable(results) {
	const columns = [
		{ header: "theme", width: Math.max(5, ...results.map((row) => row.theme.length)), get: (row) => row.theme },
		{ header: "route", width: Math.max(5, ...results.map((row) => row.route.length)), get: (row) => row.route },
		{ header: "Perf", width: 6, get: (row) => formatValue(row.score, 2) },
		{ header: "LCP(ms)", width: 8, get: (row) => formatValue(row.lcp, 0) },
		{ header: "CLS", width: 6, get: (row) => formatValue(row.cls, 3) },
		{ header: "TBT(ms)", width: 8, get: (row) => formatValue(row.tbt, 0) },
	];
	const line = (cells) => cells.map((cell, i) => String(cell).padEnd(columns[i].width)).join("  ");
	console.log("");
	console.log(line(columns.map((column) => column.header)));
	console.log(columns.map((column) => "-".repeat(column.width)).join("  "));
	for (const row of results) {
		console.log(line(columns.map((column) => column.get(row))));
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	if (!opts.noBuild) await runBuild();
	if (!existsSync(ENTRY)) throw new Error(`缺少构建产物: ${ENTRY}（去掉 --no-build 重新构建）`);

	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	log(`启动服务器 ${origin}`);
	const server = startServer(port);
	const results = [];
	let chrome;
	let db;
	let originalTheme = null;
	try {
		chrome = await launch({
			chromePath: chromePath(),
			chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
		});
		log(`Chrome 就绪（调试端口 ${chrome.port}）`);
		db = new DatabaseSync(DB_PATH);
		db.exec("PRAGMA busy_timeout = 5000");
		originalTheme = readTheme(db);

		await waitForReady(origin);
		log("服务器就绪");
		const routes = opts.routes.length > 0 ? opts.routes : await discoverRoutes(origin);
		log(`路由: ${routes.join(", ")}`);
		log(`主题: ${opts.themes.join(", ")}｜每点 ${opts.runs} 次`);
		await warmup(origin, routes);

		for (const theme of opts.themes) {
			await applyTheme(db, origin, theme);
			for (const route of routes) {
				const url = `${origin}${route}`;
				try {
					const metrics = await measure(chrome.port, url, opts.runs);
					results.push({ theme, route, ...metrics });
					log(`✓ ${theme} ${route}`);
				} catch (error) {
					results.push({ theme, route, error: error.message });
					log(`✗ ${theme} ${route}: ${error.message}`);
				}
			}
		}
	} finally {
		if (db) {
			if (originalTheme != null) setTheme(db, originalTheme);
			db.close();
		}
		if (chrome) await chrome.kill();
		await stopServer(server);
	}

	const failures = evaluate(results);
	if (opts.json) {
		console.log(JSON.stringify({ runs: opts.runs, results, failures }, null, 2));
	} else {
		printTable(results);
		console.log("");
		if (failures.length === 0) {
			log("全部通过");
		} else {
			for (const failure of failures) {
				log(`FAIL ${failure.theme} ${failure.route} ${failure.label}: ${failure.detail}`);
			}
			log(`${failures.length} 项超阈值`);
		}
	}

	return failures.length > 0 ? 1 : 0;
}

main()
	.then((code) => {
		process.exitCode = code;
		// 兜底：清理后若仍有个别句柄（如子进程 stdio）没释放，3s 后强制退出；
		// `unref` 保证正常情况下不会拖住进程（自然退出优先）。
		setTimeout(() => process.exit(code), 3000).unref();
	})
	.catch((error) => {
		console.error(`[perf] 失败: ${error.message}`);
		console.error(error.stack);
		process.exit(1);
	});
