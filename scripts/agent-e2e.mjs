#!/usr/bin/env node
/**
 * Phase 4 端到端验收：Agent 新闻室全链路（真实 HTTP）。
 *
 * 覆盖 M4 验收：author agent 注册 → 审批 → 领取选题 → 投稿（进待审）；
 * editor 审核发布；发布门禁（未 approved 无法发布，含 MCP 路径）；agent 无法越权。
 *
 * 用法（需 dev server 运行中）：
 *   node scripts/agent-e2e.mjs
 *   BASE_URL=http://localhost:4321 node scripts/agent-e2e.mjs
 *
 * 编辑侧动作全部走 **MCP**（Bearer token + JSON-RPC），与 Claude/Cursor 接入路径一致；
 * agent 侧动作走 **公开 raw 路由 + `X-Agent-Token`**（沙箱收不到 Authorization）。
 */

const BASE = (process.env.BASE_URL ?? "http://localhost:4321").replace(/\/$/, "");
const MCP_URL = `${BASE}/_emdash/api/mcp`;

const suffix = Date.now().toString(36).slice(-5);
const AGENT_SLUG = `muse-e2e-${suffix}`;
const SOURCE_URL = `https://wire.example.com/${suffix}/city-night-walk`;
// dev 下用 X-Forwarded-For 分 IP，避免注册限流（5/小时/IP）串桶。
const FAKE_IP = `10.${rnd()}.${rnd()}.${rnd()}`;
function rnd() {
	return Math.floor(Math.random() * 254) + 1;
}

const results = [];
let failed = 0;
function check(name, ok, detail = "") {
	results.push({ name, ok, detail });
	if (!ok) failed += 1;
	console.log(`${ok ? "  ok " : "FAIL "} ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------- HTTP 辅助 ----------

async function req(path, { method = "POST", body, headers = {}, cookie } = {}) {
	const res = await fetch(`${BASE}${path}`, {
		method,
		redirect: "manual",
		headers: {
			...(body !== undefined ? { "content-type": "application/json" } : {}),
			...(cookie ? { cookie } : {}),
			...headers,
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = { raw: text.slice(0, 300) };
	}
	return { status: res.status, data, res };
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

/** 调用 MCP 工具，解包工具级结果。 */
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

// ---------- 流程 ----------

async function main() {
	console.log(`\nSuda Pulse · Phase 4 端到端验收  (${BASE})`);
	console.log(`agent=${AGENT_SLUG}  ip=${FAKE_IP}\n`);

	// 1. 建 dev 会话（仅用于创建 API token）→ 创建 admin token
	const bypass = await fetch(`${BASE}/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`, {
		redirect: "manual",
	});
	const cookie = (bypass.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
	check("dev-bypass 会话建立", Boolean(cookie), `cookie 长度 ${cookie.length}`);

	const created = await req("/_emdash/api/admin/api-tokens", {
		body: { name: `e2e-${suffix}`, scopes: ["mcp:tools", "content:read", "content:write"] },
		headers: { "X-EmDash-Request": "1" },
		cookie,
	});
	const adminToken = created.data?.data?.token;
	const tokenId = created.data?.data?.info?.id;
	check(
		"创建 admin API token（scope 含 mcp:tools）",
		(created.status === 201 || created.status === 200) && Boolean(adminToken),
		`status=${created.status}`,
	);

	try {
		// 2. MCP 连通性
		const list = await mcp(adminToken, "tools/list", {});
		const names = (list.payload?.result?.tools ?? []).map((t) => t.name);
		check("MCP tools/list", list.http === 200 && names.length > 0, `${names.length} 个工具`);
		check(
			"含三个插件的工具",
			["pulse-editorial__reviewQueue", "pulse-agent__approveAgent", "pulse-subscriptions__listSubscribers"].every(
				(n) => names.includes(n),
			),
		);

		// 3. Agent 自助注册（公开 raw 路由）
		const reg = await req(`/_emdash/api/plugins/pulse-agent/agents/register`, {
			body: { slug: AGENT_SLUG, name: "Muse E2E", description: "端到端验收用 agent" },
			headers: { "x-forwarded-for": FAKE_IP },
		});
		const agentId = reg.data?.agent_id;
		const regSecret = reg.data?.registration_secret;
		check(
			"agent 注册 → pending（200）",
			reg.status === 200 && reg.data?.ok === true && reg.data?.status === "pending" && Boolean(agentId),
			`status=${reg.status}`,
		);

		// 4. 重复 slug → 409
		const dup = await req(`/_emdash/api/plugins/pulse-agent/agents/register`, {
			body: { slug: AGENT_SLUG, name: "Muse E2E dup" },
			headers: { "x-forwarded-for": FAKE_IP },
		});
		check("重复 slug → 409 SLUG_TAKEN", dup.status === 409 && dup.data?.error === "SLUG_TAKEN");

		// 5. status 查询（registration_secret）
		const st = await req(`/_emdash/api/plugins/pulse-agent/agents/status`, {
			body: { agent_id: agentId, registration_secret: regSecret },
			headers: { "x-forwarded-for": FAKE_IP },
		});
		check("agent 自助查状态 → pending", st.status === 200 && st.data?.status === "pending");

		// 6. 编辑批准（MCP）→ 签发 agent token
		const approve = await tool(adminToken, "pulse-agent__approveAgent", { agent_id: agentId });
		const agentToken = approve.data?.token;
		check(
			"编辑批准 agent（MCP）→ 签发 token",
			!approve.isError && approve.data?.ok === true && String(agentToken).startsWith(`sp_${AGENT_SLUG}_`),
			`token_prefix=${approve.data?.token_prefix}`,
		);

		// 7. agent whoami（X-Agent-Token）
		const who = await req(`/_emdash/api/plugins/pulse-agent/agents/whoami`, {
			method: "GET",
			headers: { "x-agent-token": agentToken, "x-forwarded-for": FAKE_IP },
		});
		check(
			"agent whoami → approved",
			who.status === 200 && who.data?.slug === AGENT_SLUG && who.data?.status === "approved",
		);

		// 8. 无 token 投稿 → 401（越权防护）
		const noAuth = await req(`/_emdash/api/plugins/pulse-agent/submissions/submit`, {
			body: { title: "越权投稿" },
			headers: { "x-forwarded-for": FAKE_IP },
		});
		check("无 agent token 投稿 → 401", noAuth.status === 401 && noAuth.data?.error === "UNAUTHORIZED");

		// 9. 编辑创建选题（MCP）
		const asg = await tool(adminToken, "pulse-editorial__createAssignment", {
			title: `夜行城市观察（${suffix}）`,
			brief: "采访夜间工作者，配图 3 张，1000 字以内。",
			section: "city",
			priority: "high",
		});
		const assignmentId = asg.data?.assignment_id;
		check(
			"编辑创建选题（MCP）→ open",
			!asg.isError && asg.data?.ok === true && asg.data?.status === "open" && Boolean(assignmentId),
		);

		// 10. agent 列出开放选题
		const avail = await req(`/_emdash/api/plugins/pulse-agent/assignments/available`, {
			method: "GET",
			headers: { "x-agent-token": agentToken, "x-forwarded-for": FAKE_IP },
		});
		const availIds = (avail.data?.assignments ?? []).map((a) => a.id);
		check("agent 看到开放选题", avail.status === 200 && availIds.includes(assignmentId));

		// 11. agent 领取选题
		const claim = await req(`/_emdash/api/plugins/pulse-agent/assignments/claim`, {
			body: { assignment_id: assignmentId },
			headers: { "x-agent-token": agentToken, "x-forwarded-for": FAKE_IP },
		});
		check("agent 领取选题 → claimed", claim.status === 200 && claim.data?.status === "claimed");

		// 12. 领取后：选题从 available 移除，且**条目行** task_status 已更新
		//      （回归：assignments 若开 drafts/revisions，update 只写草稿修订，
		//       条目行不变 → 选题可被重复领取。）
		const availAfter = await req(`/_emdash/api/plugins/pulse-agent/assignments/available`, {
			method: "GET",
			headers: { "x-agent-token": agentToken, "x-forwarded-for": FAKE_IP },
		});
		check(
			"领取后选题不再出现在 available",
			!(availAfter.data?.assignments ?? []).some((a) => a.id === assignmentId),
		);
		const listClaim = await tool(adminToken, "pulse-editorial__listAssignments", { limit: 100 });
		const rowClaim = (listClaim.data?.assignments ?? []).find((a) => a.id === assignmentId);
		check(
			"领取后条目行 task_status=claimed",
			rowClaim?.task_status === "claimed",
			`task_status=${rowClaim?.task_status}`,
		);

		// 13. agent 投稿（强制 pending_review）
		const submit = await req(`/_emdash/api/plugins/pulse-agent/submissions/submit`, {
			body: {
				title: `午夜城市的守夜人（${suffix}）`,
				deck: "一份关于夜间劳动者的田野笔记。",
				body: "## 午夜之后\n\n城市并未睡去。\n\n- 便利店店员\n- 出租车司机\n\n他们构成了城市的另一条时间线。",
				section: "city",
				tags: ["city", "labor"],
				source: "Suda Wire",
				source_url: SOURCE_URL,
				assignment_id: assignmentId,
			},
			headers: { "x-agent-token": agentToken, "x-forwarded-for": FAKE_IP },
		});
		const articleId = submit.data?.article_id;
		const articleSlug = submit.data?.slug;
		check(
			"agent 投稿 → pending_review（进待审）",
			submit.status === 200 && submit.data?.status === "pending_review" && Boolean(articleId),
			`status=${submit.status} ${JSON.stringify(submit.data).slice(0, 260)}`,
		);

		// 14. 投稿后：选题条目行置 submitted 并回填 submitted_article
		const listSubmit = await tool(adminToken, "pulse-editorial__listAssignments", { limit: 100 });
		const rowSubmit = (listSubmit.data?.assignments ?? []).find((a) => a.id === assignmentId);
		check(
			"投稿后条目行 task_status=submitted",
			rowSubmit?.task_status === "submitted",
			`task_status=${rowSubmit?.task_status}`,
		);
		const asgGet = await tool(adminToken, "content_get", { collection: "assignments", id: assignmentId });
		check(
			"投稿后回填 assignments.submitted_article",
			asgGet.data?.item?.data?.submitted_article === articleId,
			`submitted_article=${asgGet.data?.item?.data?.submitted_article}`,
		);

		// 15. 幂等：同 source_url 再投 → duplicate 同 id
		const again = await req(`/_emdash/api/plugins/pulse-agent/submissions/submit`, {
			body: { title: "重复投稿", source_url: SOURCE_URL },
			headers: { "x-agent-token": agentToken, "x-forwarded-for": FAKE_IP },
		});
		check("同 source_url 幂等（duplicate 同 id）", again.data?.duplicate === true && again.data?.article_id === articleId);

		// 16. 发布门禁（MCP 路径）：未 approved 直接 publish → 被 pulse-review 拒绝。
		//     publish 需要乐观锁 `_rev`（来自 content_get 顶层），且作用于**草稿修订**；
		//     新建条目尚无修订，故先 update 一次造出草稿修订，再取新 `_rev` 尝试发布。
		const got0 = await tool(adminToken, "content_get", { collection: "articles", id: articleId });
		const bump = await tool(adminToken, "content_update", {
			collection: "articles",
			id: articleId,
			_rev: got0.data?._rev,
			data: { review_note: "gate probe" },
		});
		const got1 = await tool(adminToken, "content_get", { collection: "articles", id: articleId });
		const revId = got1.data?._rev;
		check(
			"造出草稿修订并取到 _rev",
			!bump.isError && Boolean(revId),
			`bump_ok=${!bump.isError} rev=${String(revId).slice(0, 24)}`,
		);

		const gate = await tool(adminToken, "content_publish", {
			collection: "articles",
			id: articleId,
			_rev: revId,
		});
		const gateText = `${gate.code ?? ""} ${gate.data?.raw ?? ""} ${gate.data?.reason ?? ""}`;
		check(
			"发布门禁（MCP）：pending_review 直接 publish 被拒",
			gate.isError === true && !/validation error/i.test(gateText) && /PUBLISH_REJECTED|approved|审核/.test(gateText),
			gateText.trim().slice(0, 120),
		);

		// 17. 编辑待审队列（MCP）→ 含该稿件
		const queue = await tool(adminToken, "pulse-editorial__reviewQueue", {});
		const inQueue = (queue.data?.submissions ?? []).some((s) => s.id === articleId);
		check("待审队列含该稿件（MCP）", !queue.isError && inQueue, `count=${queue.data?.count}`);

		// 18. 编辑查看稿件详情（MCP）
		const detail = await tool(adminToken, "pulse-editorial__getSubmission", { article_id: articleId });
		check(
			"稿件详情含正文与署名",
			!detail.isError && detail.data?.article?.data?.author_agent === AGENT_SLUG,
			`author=${detail.data?.article?.data?.author_agent}`,
		);

		// 19. 编辑批准并发布（MCP）
		const approveArt = await tool(adminToken, "pulse-editorial__approveArticle", {
			article_id: articleId,
			review_note: "通过，发布。",
		});
		check(
			"编辑批准并发布（MCP）→ published",
			!approveArt.isError && approveArt.data?.status === "published",
			`slug=${approveArt.data?.slug}`,
		);

		// 20. 前台可见
		const page = await fetch(`${BASE}/articles/${approveArt.data?.slug ?? articleSlug}`);
		const html = await page.text();
		check("前台文章页 200 且含标题", page.status === 200 && html.includes("守夜人"), `status=${page.status}`);

		// 21. agent token 不能当 EmDash token 用（无法触达 MCP）
		const asBearer = await mcp(agentToken, "tools/list", {});
		check(
			"agent token 无法用于 MCP（隔离）",
			asBearer.http === 401,
			`http=${asBearer.http} code=${asBearer.payload?.error?.code ?? asBearer.payload?.code}`,
		);
	} finally {
		// 清理：撤销 admin token
		if (tokenId) {
			await req(`/_emdash/api/admin/api-tokens/${tokenId}`, {
				method: "DELETE",
				headers: { "X-EmDash-Request": "1" },
				cookie,
			});
		}
	}

	console.log(`\n结果：${results.length - failed}/${results.length} 通过${failed ? `，${failed} 失败` : ""}\n`);
	process.exit(failed ? 1 : 0);
}

main().catch((error) => {
	console.error("\n[e2e] 运行失败：", error);
	process.exit(1);
});
