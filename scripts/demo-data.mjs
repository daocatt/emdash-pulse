#!/usr/bin/env node
/**
 * Demo 互动数据：评论 + 订阅者 + 订阅分组 + 事件日志。
 *
 * 与 `seed/seed.json` 的分工：
 * - seed 负责**内容**（集合 / 分类 / 菜单 / 文章 / 期号 / 页面 / 媒体），由部署后的
 *   setup 向导灌入；
 * - 本脚本负责 seed 覆盖不到的**互动数据**——它们不在 `SeedFile` 的类型里：
 *   评论落在核心表 `_emdash_comments`，订阅者 / 分组 / 事件落在插件存储
 *   `_plugin_storage`（`plugin_id = "pulse-subscriptions"`）。
 *
 * 目标数据库：**PostgreSQL**（本项目的唯一数据库，见 docs/16-vps-deployment.md）。
 * 连接串取 `--database-url`，其次 `DATABASE_URL`，都没有时回退标准 libpq 变量
 * （PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD）。
 *
 * 三种模式：
 * - 默认：先按标记清理上一次的 demo 数据，再写入（幂等，可反复跑）；
 * - `--clean`：只清理，不写入；
 * - `--keep`：只写入，不清理（追加）。
 *
 * 清理标记：评论按 `author_email LIKE '%@<DEMO_EMAIL_DOMAIN>'`、订阅者按
 * `data ->> 'email' LIKE '%@<DEMO_EMAIL_DOMAIN>'`；分组只清本脚本声明的 slug
 * （后台可能手工建过别的分组）；事件按插件整集合清空（事件只由这些 demo 订阅者产生）。
 *
 * 用法：
 *   node scripts/demo-data.mjs                    # 清 + 灌
 *   node scripts/demo-data.mjs --clean            # 只清
 *   node scripts/demo-data.mjs --keep             # 只灌
 *   node scripts/demo-data.mjs --dry-run          # 只打印将执行的 SQL
 *   node scripts/demo-data.mjs --database-url postgres://…@host:5432/pulse
 */

import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";

// ---------- 常量 ----------

/** demo 数据标记域名：清理与识别都靠它（评论邮件不对外展示，仅后台/清理用）。 */
const DEMO_EMAIL_DOMAIN = "dev.suda.im";
const PLUGIN_ID = "pulse-subscriptions";
const SUBSCRIBERS_COLLECTION = "subscribers";
const GROUPS_COLLECTION = "groups";
const EVENTS_COLLECTION = "events";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------- 参数 ----------

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const argValue = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/** 连接串优先级：`--database-url` → `DATABASE_URL` → 标准 libpq 变量（PG*）。 */
const DATABASE_URL = argValue("--database-url", process.env.DATABASE_URL);
const DRY_RUN = hasFlag("--dry-run");

if (hasFlag("--clean") && hasFlag("--keep")) {
	console.error("--clean 与 --keep 互斥：--clean 只清、--keep 只灌。");
	process.exit(1);
}
/** replace（默认，先清后灌）/ clean（只清）/ inject（只灌）。 */
const MODE = hasFlag("--clean") ? "clean" : hasFlag("--keep") ? "inject" : "replace";

// ---------- 工具 ----------

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 生成 ULID（与 EmDash 的 `ulid()` 同格式：10 位时间 + 16 位随机）。 */
function ulid(at = Date.now()) {
	let time = "";
	for (let n = at, i = 0; i < 10; i++) {
		time = B32[n % 32] + time;
		n = Math.floor(n / 32);
	}
	const rand = randomBytes(16);
	let tail = "";
	for (let i = 0; i < 16; i++) tail += B32[rand[i] % 32];
	return time + tail;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** 与插件 `hashEmail` 一致：规范化（trim + 小写）后的 SHA-256。 */
const hashEmail = (email) => sha256(email.trim().toLowerCase());

const demoEmail = (local) => `${local}@${DEMO_EMAIL_DOMAIN}`;

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

/** SQL 字面量：`null` 或单引号包裹并把内部单引号翻倍。 */
const sqlStr = (value) =>
	value === null || value === undefined ? "null" : `'${String(value).replace(/'/g, "''")}'`;

// ---------- Demo 内容 ----------

/**
 * 评论线程：按文章 slug 分组，顶层评论 + 递归 replies。
 * 时间从「最近」往前铺，保证前台按 `created_at ASC` 展示时顺序自然。
 */
const COMMENT_THREADS = {
	"suda-pulse-launch": [
		{
			name: "林一",
			email: "linyi",
			body: "恭喜上线！「Agent 与人类编辑在同一个编辑室协作」这个定位很有意思，期待看到更多实战案例。",
			replies: [
				{
					name: "周舟",
					email: "zhouzhou",
					body: "同感。不过有点好奇 Agent 的稿件在风格上怎么和人类记者统一？",
					replies: [
						{
							name: "林一",
							email: "linyi",
							body: "文章里提到发布前有审核门禁，风格应该还是靠编辑把关吧。",
						},
					],
				},
			],
		},
		{
			name: "陈默",
			email: "chenmo",
			body: "图片新闻那条链路（R2 + 响应式 srcset）体验不错，首屏加载很快。",
		},
		{
			name: "苏晚",
			email: "suwan",
			body: "订阅入口藏得有点深，建议在文章页底部也放一个。",
		},
		{
			name: "Kevin Wu",
			email: "kevin",
			body: "Read API 的限流策略能展开讲讲吗？想接一下做聚合阅读。",
			replies: [
				{
					name: "编辑部",
					email: "desk",
					body: "限流按 (route, client) 计数，公开只读端点是每 IP 每窗口若干次；细节见 /pages/agents。",
				},
			],
		},
	],
	"review-workflow": [
		{
			name: "赵晴",
			email: "zhaoqing",
			body: "审核状态机的图很清晰，建议再补一张「退回修改」的时序图。",
		},
		{
			name: "李让",
			email: "lirang",
			body: "AI 审核失败要降级到规则、绝不自动通过，这条红线很关键。",
			replies: [
				{
					name: "赵晴",
					email: "zhaoqing",
					body: "对，宁可多进待审队列，也不能放行。",
				},
			],
		},
		{
			name: "匿名读者",
			email: "anon",
			body: "想问一下被驳回的稿件，作者会收到通知吗？",
			replies: [
				{
					name: "编辑部",
					email: "desk",
					body: "会。审核意见写在 review_note 字段里，作者在后台能看到。",
				},
			],
		},
	],
	"cross-border-data-rules": [
		{
			name: "王岸",
			email: "wangan",
			body: "各地监管口径差异确实越来越大，合规成本最后大概率还是会转嫁到用户身上。",
		},
		{
			name: "何苏",
			email: "hesu",
			body: "文中提到数据本地化，但对小团队来说落地成本太高了。",
			replies: [
				{
					name: "王岸",
					email: "wangan",
					body: "所以才有区域化部署的方案，只是复杂度又上去了。",
				},
			],
		},
		{
			name: "Nina",
			email: "nina",
			body: "有没有横向对比表格？纯文字读起来有点难比较不同地区的口径。",
		},
	],
};

/** 订阅分组：slug 即记录 id（创建后不可变）。 */
const GROUPS = [
	{ slug: "daily", name: "每日摘要", description: "每天早上推送前一天的报道精选。", sortOrder: 1, active: true },
	{ slug: "weekly", name: "每周精选", description: "每周一封，编辑部挑的长文与深度报道。", sortOrder: 2, active: true },
	{ slug: "breaking", name: "突发新闻", description: "重大事件即时推送，频率不固定。", sortOrder: 3, active: true },
	// 已停用：不出现在前台表单，但保留已有订阅关系（后台应显示为「停用」）。
	{ slug: "podcast-club", name: "播客俱乐部", description: "（已停用）播客更新通知。", sortOrder: 9, active: false },
];

/** 订阅者：状态混合，个别带「待发邮件」快照 / 分组 / 暂停信息以覆盖后台不同展示。 */
const SUBSCRIBERS = [
	{ local: "linyi", status: "confirmed", source: "web", daysAgo: 21, groups: ["daily", "weekly"] },
	{ local: "zhouzhou", status: "confirmed", source: "web", daysAgo: 18, groups: ["weekly"] },
	{ local: "chenmo", status: "confirmed", source: "article", daysAgo: 12, groups: ["daily"] },
	{ local: "suwan", status: "confirmed", source: "web", daysAgo: 9 },
	{ local: "kevin", status: "confirmed", source: "footer", daysAgo: 6, groups: ["breaking", "daily"] },
	{ local: "zhaoqing", status: "confirmed", source: "web", daysAgo: 3, groups: ["weekly", "podcast-club"] },
	{ local: "lirang", status: "pending", source: "web", daysAgo: 2 },
	{ local: "wangan", status: "pending", source: "article", daysAgo: 1, groups: ["breaking"] },
	{ local: "hesu", status: "pending", source: "web", hoursAgo: 8 },
	// 邮件未投递（无 provider / 投递失败）时保留的待发快照。
	{ local: "nina", status: "pending", source: "web", hoursAgo: 5, undelivered: true },
	{ local: "mika", status: "unsubscribed", source: "web", daysAgo: 30, unsubDaysAgo: 4, unsubReason: "频率太高" },
	{ local: "oliver", status: "unsubscribed", source: "web", daysAgo: 45, unsubDaysAgo: 11, unsubReason: "内容不相关" },
	// 后台主动暂停：读者重新提交订阅也不会自动恢复。
	{
		local: "tian",
		status: "paused",
		source: "web",
		daysAgo: 14,
		pauseDaysAgo: 3,
		pauseReason: "收件地址被投诉，待编辑部核实",
		groups: ["daily"],
	},
];

// ---------- 行生成 ----------

/** 把线程递归展开成扁平的评论行（含 parent_id）。父行先于子行，满足自引用外键。 */
function flattenThreads(threads, contentId, startMs) {
	const rows = [];
	let elapsed = 0;

	const walk = (items, parentId) => {
		for (const item of items) {
			// 首条最旧，随后逐条推近当前时间；回复晚于其父评论。
			const msAgo = Math.max(0, startMs - elapsed);
			const createdAt = iso(msAgo);
			elapsed += 7 * MINUTE;
			const id = ulid(Date.now() - msAgo);
			rows.push({
				id,
				collection: "articles",
				content_id: contentId,
				parent_id: parentId,
				author_name: item.name,
				author_email: demoEmail(item.email),
				body: item.body,
				status: "approved",
				ip_hash: null,
				user_agent: "demo-data",
				moderation_metadata: JSON.stringify({ source: "demo-data", decision: "approved" }),
				created_at: createdAt,
				updated_at: createdAt,
			});
			if (item.replies?.length) walk(item.replies, id);
		}
	};

	walk(threads, null);
	return rows;
}

function buildSubscriberRecord(spec) {
	const email = demoEmail(spec.local);
	const createdAtMs = (spec.daysAgo ?? 0) * DAY + (spec.hoursAgo ?? 0) * HOUR;
	const createdAt = iso(createdAtMs);
	// paused 只从 confirmed 进入（见 operations.ts），所以它也带 confirmedAt。
	const confirmedAt =
		spec.status === "confirmed" || spec.status === "unsubscribed" || spec.status === "paused"
			? iso(createdAtMs - 2 * MINUTE)
			: undefined;
	const unsubscribedAt =
		spec.unsubDaysAgo != null ? iso(spec.unsubDaysAgo * DAY) : undefined;
	const pausedAt = spec.pauseDaysAgo != null ? iso(spec.pauseDaysAgo * DAY) : undefined;

	// 确认 / 退订 token 只存哈希，明文仅在邮件链接里；demo 数据用随机值占位。
	const token = `ps_${spec.status === "pending" ? "confirm" : "unsub"}_${sha256(email)}`;
	const record = {
		email,
		emailHash: hashEmail(email),
		status: spec.status,
		tokenHash: sha256(token),
		tokenPrefix: token.slice(0, 12),
		tokenPurpose: spec.status === "pending" ? "confirm" : "unsubscribe",
		source: spec.source,
		groups: spec.groups ?? [],
		createdAt,
		requestedAt: createdAt,
		emailDelivered: !spec.undelivered,
		lastSentAt: createdAt,
		...(confirmedAt ? { confirmedAt } : {}),
		...(unsubscribedAt ? { unsubscribedAt } : {}),
		...(spec.unsubReason ? { unsubscribeReason: spec.unsubReason } : {}),
		...(pausedAt ? { pausedAt, pausedBy: "admin", pausedFrom: "confirmed" } : {}),
		...(spec.pauseReason ? { pauseReason: spec.pauseReason } : {}),
	};
	if (spec.undelivered) {
		record.pendingEmail = {
			to: email,
			subject: "确认订阅 Suda Pulse",
			text: "（demo 数据）点击链接确认订阅。",
			reason: "邮件服务未配置",
			at: createdAt,
		};
	}
	return { id: `sub_${sha256(email).slice(0, 32)}`, data: record };
}

function buildGroupRecord(spec) {
	const createdAt = iso(30 * DAY);
	return {
		id: spec.slug,
		data: {
			name: spec.name,
			...(spec.description ? { description: spec.description } : {}),
			sortOrder: spec.sortOrder,
			active: spec.active,
			createdAt,
		},
	};
}

/** 按订阅者当前态铺一条事件时间线（后台按 `at` 倒序展示）。 */
function buildEvents(spec, id, record) {
	const events = [];
	const push = (type, at, actor, extra = {}) => {
		if (!at) return;
		events.push({
			// 同一条记录里 (type, at) 可能重复（如 requested 与 groups_changed 同一时刻），
			// 用哈希保证 id 唯一，避免同主键互相覆盖。
			id: `evt_${sha256(`${id}:${type}:${at}`).slice(0, 32)}`,
			// 刻意不写 emailHash：subscribers 的 uniqueIndexes 是全表唯一索引，
			// 同名字段会让同一订阅者的第 2 条事件撞唯一约束（详见插件 events.ts 注释）。
			data: { subscriberId: id, type, at, actor, ...extra },
		});
	};

	push("requested", record.createdAt, "reader");
	if (record.groups.length > 0) {
		push("groups_changed", record.createdAt, "reader", { detail: record.groups.join(",") });
	}
	push("confirmed", record.confirmedAt, "reader");
	if (spec.status === "paused") {
		push("paused", record.pausedAt, "admin", {
			...(record.pauseReason ? { reason: record.pauseReason } : {}),
		});
	}
	if (spec.status === "unsubscribed") {
		push("unsubscribed", record.unsubscribedAt, "reader", {
			...(record.unsubscribeReason ? { reason: record.unsubscribeReason } : {}),
		});
	}
	return events;
}

// ---------- SQL ----------

const COMMENT_INSERT_COLUMNS =
	"(id, collection, content_id, parent_id, author_name, author_email, body, status, " +
	"ip_hash, user_agent, moderation_metadata, created_at, updated_at)";

/** 清理语句。顺序：评论 → 订阅者 → 分组 → 事件。 */
function cleanStatements() {
	const like = `%@${DEMO_EMAIL_DOMAIN}`;
	return [
		`DELETE FROM _emdash_comments WHERE author_email LIKE ${sqlStr(like)};`,
		`DELETE FROM _plugin_storage WHERE plugin_id = ${sqlStr(PLUGIN_ID)} AND collection = ${sqlStr(SUBSCRIBERS_COLLECTION)} AND (data::jsonb ->> 'email') LIKE ${sqlStr(like)};`,
		`DELETE FROM _plugin_storage WHERE plugin_id = ${sqlStr(PLUGIN_ID)} AND collection = ${sqlStr(GROUPS_COLLECTION)} AND id IN (${GROUPS.map((g) => sqlStr(g.slug)).join(", ")});`,
		`DELETE FROM _plugin_storage WHERE plugin_id = ${sqlStr(PLUGIN_ID)} AND collection = ${sqlStr(EVENTS_COLLECTION)};`,
	];
}

/** 清理前的计数（按同样的标记，报告用）。 */
function countStatements() {
	const like = `%@${DEMO_EMAIL_DOMAIN}`;
	return [
		{ label: "评论", sql: `SELECT count(*) AS n FROM _emdash_comments WHERE author_email LIKE ${sqlStr(like)};` },
		{
			label: "订阅者",
			sql: `SELECT count(*) AS n FROM _plugin_storage WHERE plugin_id = ${sqlStr(PLUGIN_ID)} AND collection = ${sqlStr(SUBSCRIBERS_COLLECTION)} AND (data::jsonb ->> 'email') LIKE ${sqlStr(like)};`,
		},
		{
			label: "分组",
			sql: `SELECT count(*) AS n FROM _plugin_storage WHERE plugin_id = ${sqlStr(PLUGIN_ID)} AND collection = ${sqlStr(GROUPS_COLLECTION)} AND id IN (${GROUPS.map((g) => sqlStr(g.slug)).join(", ")});`,
		},
		{
			label: "事件",
			sql: `SELECT count(*) AS n FROM _plugin_storage WHERE plugin_id = ${sqlStr(PLUGIN_ID)} AND collection = ${sqlStr(EVENTS_COLLECTION)};`,
		},
	];
}

const PUBLISHED_ARTICLES_SQL =
	"SELECT id, slug FROM ec_articles WHERE status = 'published';";

/** 生成注入语句；返回 { sql: string[], stats }。 */
function insertStatements(idBySlug) {
	const statements = [];
	const stats = { comments: 0, subscribers: 0, groups: 0, events: 0, byStatus: {}, perArticle: [] };
	const skipped = [];

	for (const [slug, threads] of Object.entries(COMMENT_THREADS)) {
		const contentId = idBySlug.get(slug);
		if (!contentId) {
			skipped.push(slug);
			continue;
		}
		const rows = flattenThreads(threads, contentId, 2 * DAY);
		for (const row of rows) {
			const values = [
				sqlStr(row.id),
				sqlStr(row.collection),
				sqlStr(row.content_id),
				sqlStr(row.parent_id),
				sqlStr(row.author_name),
				sqlStr(row.author_email),
				sqlStr(row.body),
				sqlStr(row.status),
				sqlStr(row.ip_hash),
				sqlStr(row.user_agent),
				sqlStr(row.moderation_metadata),
				sqlStr(row.created_at),
				sqlStr(row.updated_at),
			];
			statements.push(
				`INSERT INTO _emdash_comments ${COMMENT_INSERT_COLUMNS} VALUES (${values.join(", ")});`,
			);
		}
		stats.comments += rows.length;
		stats.perArticle.push(`${slug} (${rows.length})`);
	}

	for (const spec of GROUPS) {
		const { id, data } = buildGroupRecord(spec);
		statements.push(
			`INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at) VALUES (${[
				sqlStr(PLUGIN_ID),
				sqlStr(GROUPS_COLLECTION),
				sqlStr(id),
				sqlStr(JSON.stringify(data)),
				sqlStr(data.createdAt),
				sqlStr(data.createdAt),
			].join(", ")});`,
		);
		stats.groups += 1;
	}

	for (const spec of SUBSCRIBERS) {
		const { id, data } = buildSubscriberRecord(spec);
		statements.push(
			`INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at) VALUES (${[
				sqlStr(PLUGIN_ID),
				sqlStr(SUBSCRIBERS_COLLECTION),
				sqlStr(id),
				sqlStr(JSON.stringify(data)),
				sqlStr(data.createdAt),
				sqlStr(data.createdAt),
			].join(", ")});`,
		);
		stats.subscribers += 1;
		stats.byStatus[data.status] = (stats.byStatus[data.status] ?? 0) + 1;

		for (const event of buildEvents(spec, id, data)) {
			statements.push(
				`INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at) VALUES (${[
					sqlStr(PLUGIN_ID),
					sqlStr(EVENTS_COLLECTION),
					sqlStr(event.id),
					sqlStr(JSON.stringify(event.data)),
					sqlStr(event.data.at),
					sqlStr(event.data.at),
				].join(", ")});`,
			);
			stats.events += 1;
		}
	}

	return { statements, stats, skipped };
}

// ---------- 适配器（PostgreSQL） ----------

/** 脱敏连接串里的口令，避免日志 / 报错外泄。 */
function redact(url) {
	return url.replace(/:\/\/([^:/@]+):[^@]*@/, "://$1:***@");
}

/**
 * 单个 PG 连接执行 demo SQL。
 * - `queryBatch`：逐条执行 SELECT 并收集 `rows`（清理前计数 / 取已发布文章）；
 * - `exec`：一次性执行多语句脚本（simple query 协议允许分号分隔）。
 */
function postgresAdapter() {
	const client = new Client(DATABASE_URL ? { connectionString: DATABASE_URL } : {});
	return {
		label: DATABASE_URL
			? `PostgreSQL ${redact(DATABASE_URL)}`
			: "PostgreSQL（libpq PG* 环境变量）",
		async connect() {
			try {
				await client.connect();
			} catch (error) {
				throw new Error(
					`无法连接 PostgreSQL：${error instanceof Error ? error.message : String(error)}\n` +
						"请设置 DATABASE_URL（或 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD）。",
				);
			}
		},
		async queryBatch(sqls) {
			const out = [];
			for (const sql of sqls) out.push((await client.query(sql)).rows);
			return out;
		},
		async exec(sqlText) {
			await client.query(sqlText);
		},
		async close() {
			await client.end();
		},
	};
}

// ---------- 主流程 ----------

async function main() {
	const adapter = postgresAdapter();
	await adapter.connect();
	console.log(`目标：${adapter.label}｜模式：${MODE}${DRY_RUN ? "｜dry-run" : ""}`);

	const counts = countStatements();

	// 1) 清理（replace / clean）
	if (MODE !== "inject") {
		const before = (await adapter.queryBatch(counts.map((c) => c.sql))).map((rows) =>
			Number(rows[0]?.n ?? 0),
		);
		const summary = counts
			.map((c, i) => `${c.label} ${before[i]}`)
			.join("，");
		if (DRY_RUN) {
			console.log(`\n-- 将清理：${summary}\n${cleanStatements().join("\n")}`);
		} else {
			await adapter.exec(cleanStatements().join("\n"));
			console.log(`清理旧 demo 数据：${summary}`);
		}
	}

	if (MODE === "clean") {
		console.log("\n仅清理，未写入。");
		await adapter.close();
		return;
	}

	// 2) 取已发布文章，建立 slug → ULID 映射（评论的 content_id 用 ULID）
	const published = (await adapter.queryBatch([PUBLISHED_ARTICLES_SQL]))[0] ?? [];
	const idBySlug = new Map(published.map((row) => [row.slug, row.id]));

	const { statements, stats, skipped } = insertStatements(idBySlug);
	for (const slug of skipped) {
		console.warn(`跳过评论：找不到已发布文章 ${slug}`);
	}

	if (DRY_RUN) {
		console.log(`\n-- 将写入 ${statements.length} 条语句：\n${statements.join("\n")}`);
		await adapter.close();
		return;
	}

	await adapter.exec(statements.join("\n"));
	await adapter.close();

	const byStatus = stats.byStatus;
	console.log("\n写入完成：");
	console.log(`  评论 ${stats.comments} 条 —— ${stats.perArticle.join("、")}`);
	console.log(
		`  订阅者 ${stats.subscribers} 条 —— confirmed ${byStatus.confirmed ?? 0} / pending ${byStatus.pending ?? 0} / paused ${byStatus.paused ?? 0} / unsubscribed ${byStatus.unsubscribed ?? 0}`,
	);
	console.log(`  分组 ${stats.groups} 个 —— ${GROUPS.map((g) => g.slug).join("、")}`);
	console.log(`  事件 ${stats.events} 条`);
	console.log(
		"\n前台：/articles/<slug> 评论区、/subscribe 分组勾选、订阅管理页；后台：/_emdash/admin/plugins/pulse-subscriptions",
	);
}

await main();
