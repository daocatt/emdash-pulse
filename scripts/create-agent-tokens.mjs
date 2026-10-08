#!/usr/bin/env node
/**
 * 生成各 agent 的 scoped EmDash API token（MCP 通道用）。
 *
 * 设计（见 docs/06-mcp-agents.md §2.1）：
 * - **Editor agent** → `mcp:tools:pulse-editorial` + `content:read/write`：
 *   调用 `pulse-editorial__*`（reviewQueue / approveArticle / rejectArticle / createAssignment …）。
 * - **Reader agent** → 仅 `content:read`：走 MCP 只读（content_list / search），或直接用公开
 *   Agent Read API（无需 token）。
 * - **Author agent** → **不签发 EmDash token**。其身份是 `pulse-agent` 的 `sp_` token
 *   （HTTP + `X-Agent-Token`），投稿强制 `pending_review`，物理上无发布权；若签发
 *   `content:write` 的 EmDash token（必然挂在 Admin 名下），反而能绕过门禁直接发布。
 *
 * token 明文**只在创建响应里出现一次**；脚本会打印一次并提示立即转交/保存。
 * 重复运行会先撤销同名旧 token（幂等）。
 *
 * ⚠ **仅本地 dev 便捷工具**：这里签发的 token 都挂在 Admin 名下。生产环境的第三方 editor
 * 接入**不要**用本脚本 —— 走「用户成为 Editor + EmDash 原生 OAuth」（D22，见
 * docs/13-editor-onboarding.md）：Editor 用户的 agent 用 OAuth 以**自己**的身份连 MCP，
 * 审计归属正确、可单独撤销。本脚本只用于本地联调。
 *
 * 用法（dev server 需运行）：
 *   node scripts/create-agent-tokens.mjs
 *   PULSE_BASE=https://ai.suda.im node scripts/create-agent-tokens.mjs   # 生产慎用（见上）
 */

const BASE = (process.env.PULSE_BASE ?? "http://localhost:4321").replace(/\/$/, "");
const MCP_URL = `${BASE}/_emdash/api/mcp`;
const REQ_HEADER = { "X-EmDash-Request": "1" };

/** 令牌矩阵。`scopes` 顺序即创建顺序。 */
const TOKENS = [
	{
		name: "pulse-editor-agent",
		scopes: ["mcp:tools:pulse-editorial", "content:read", "content:write"],
		note: "Editor agent：审核队列 / 通过驳回 / 发布 / 选题分发",
	},
	{
		name: "pulse-reader-agent",
		scopes: ["content:read"],
		note: "Reader agent：MCP 只读（content_list / search）",
	},
];

// ---------- HTTP ----------

async function authenticate() {
	const res = await fetch(`${BASE}/_emdash/api/setup/dev-bypass?redirect=/`, { redirect: "manual" });
	const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
	if (!cookie) throw new Error("dev-bypass 未返回会话 cookie（是否已启动 dev server？）");
	return cookie;
}

async function api(cookie, path, { method = "GET", body } = {}) {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: {
			cookie,
			...REQ_HEADER,
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = { raw: text.slice(0, 200) };
	}
	return { status: res.status, json };
}

/** MCP JSON-RPC（响应是 SSE，取 data: 行）。 */
async function mcp(token, method, params) {
	const res = await fetch(MCP_URL, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const text = await res.text();
	const line = text.split("\n").find((l) => l.startsWith("data: "));
	return { http: res.status, payload: JSON.parse(line ? line.slice(6) : text) };
}

/** 调用 MCP 工具，解包工具级错误码。 */
async function tool(token, name, args = {}) {
	const { http, payload } = await mcp(token, "tools/call", { name, arguments: args });
	const r = payload.result ?? payload;
	let data;
	try {
		data = JSON.parse(r?.content?.[0]?.text ?? "");
	} catch {
		data = { raw: r?.content?.[0]?.text };
	}
	return { http, isError: Boolean(r?.isError), code: r?._meta?.code, data, error: payload.error };
}

// ---------- 主流程 ----------

let failed = 0;
function check(name, ok, detail = "") {
	if (!ok) failed += 1;
	console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
	console.log(`\nSuda Pulse · 生成 agent scoped token  (${BASE})\n`);
	const cookie = await authenticate();

	// 幂等：撤销同名旧 token。
	const list = await api(cookie, "/_emdash/api/admin/api-tokens");
	const existing = list.json?.data?.items ?? [];
	const names = new Set(TOKENS.map((t) => t.name));
	for (const item of existing.filter((i) => names.has(i.name))) {
		await api(cookie, `/_emdash/api/admin/api-tokens/${item.id}`, { method: "DELETE" });
		console.log(`  撤销旧 token ${item.name}（${item.prefix}…）`);
	}

	const created = [];
	for (const spec of TOKENS) {
		const res = await api(cookie, "/_emdash/api/admin/api-tokens", {
			method: "POST",
			body: { name: spec.name, scopes: spec.scopes },
		});
		const token = res.json?.data?.token;
		const info = res.json?.data?.info;
		check(
			`创建 ${spec.name}`,
			(res.status === 201 || res.status === 200) && Boolean(token),
			`status=${res.status} prefix=${info?.prefix ?? "-"}`,
		);
		if (token) created.push({ ...spec, token, prefix: info?.prefix, id: info?.id });
	}

	const editor = created.find((t) => t.name === "pulse-editor-agent");
	const reader = created.find((t) => t.name === "pulse-reader-agent");

	console.log("\n验证：");
	if (editor) {
		const list2 = await mcp(editor.token, "tools/list", {});
		const names2 = (list2.payload?.result?.tools ?? []).map((t) => t.name);
		check("editor token tools/list", list2.http === 200 && names2.length > 0, `${names2.length} 个工具`);

		const queue = await tool(editor.token, "pulse-editorial__reviewQueue", {});
		check(
			"editor token 可调 pulse-editorial__reviewQueue",
			!queue.isError || !/INSUFFICIENT_SCOPE/.test(String(queue.code ?? queue.error?.message ?? "")),
			`code=${queue.code ?? "ok"} count=${queue.data?.count ?? "-"}`,
		);

		const noScope = await tool(editor.token, "pulse-agent__listAgentRegistrations", {});
		check(
			"editor token 无 pulse-agent scope → 被拒",
			/INSUFFICIENT_SCOPE/.test(String(noScope.code ?? noScope.error?.message ?? "")),
			`code=${noScope.code ?? noScope.error?.message ?? "-"}`,
		);
	}
	if (reader) {
		const list3 = await tool(reader.token, "content_list", { collection: "articles", limit: 1 });
		check("reader token 可调 content_list（content:read）", !list3.isError, `code=${list3.code ?? "ok"}`);

		const denied = await tool(reader.token, "pulse-editorial__reviewQueue", {});
		check(
			"reader token 无 mcp:tools → 被拒",
			/INSUFFICIENT_SCOPE/.test(String(denied.code ?? denied.error?.message ?? "")),
			`code=${denied.code ?? denied.error?.message ?? "-"}`,
		);

		const pub = await tool(reader.token, "content_publish", { collection: "articles", id: "x", _rev: "x" });
		check(
			"reader token 无 content:write → 无法发布（最小权限）",
			/INSUFFICIENT_SCOPE/.test(String(pub.code ?? pub.error?.message ?? "")),
			`code=${pub.code ?? pub.error?.message ?? "-"}`,
		);
	}

	console.log("\n令牌（明文仅此一次，请立即转交对应 agent）：\n");
	for (const t of created) {
		console.log(`  ${t.name}  (${t.note})`);
		console.log(`    scopes: ${t.scopes.join(", ")}`);
		console.log(`    token : ${t.token}`);
		console.log("");
	}
	console.log("Author agent 不签发 EmDash token：用 pulse-agent 的 `sp_<slug>_…`（X-Agent-Token + 公开路由，强制待审）。");
	console.log(`\n结果：${failed === 0 ? "全部通过" : `${failed} 项失败`}\n`);
	process.exit(failed ? 1 : 0);
}

main().catch((err) => {
	console.error(`\n[tokens] 失败: ${err.message}\n`);
	process.exit(1);
});
