#!/usr/bin/env node
/**
 * 本地测试数据：一批评论 + 一批订阅者 + 订阅分组 / 事件日志（仅用于 dev 复核 UI）。
 *
 * - 评论：写入 `_emdash_comments`（全部 `status='approved'`，含楼中楼回复），
 *   落到几篇已发布文章上，前台文章页评论区立即可见。
 * - 订阅者：写入插件存储 `_plugin_storage`
 *   （`pulse-subscriptions` / `subscribers`），状态混合
 *   `confirmed` / `pending` / `unsubscribed` / `paused`，供后台「订阅者」页复核。
 * - 分组：同表 `groups` 集合（slug 即记录 id）。
 * - 事件日志：同表 `events` 集合，按订阅者铺一条时间线，供后台「订阅记录」子视图复核。
 *
 * 幂等：默认先按邮箱标记（`@test.suda.im`）清除上一次的测试数据再写入；
 * 加 `--keep` 则只追加不清除。
 * 注意：`events` 集合按插件整体清空（事件只由这些测试订阅者产生），
 * `groups` 只清本脚本声明的 slug。
 *
 * 用法（dev server 可保持运行，SQLite 为 WAL）：
 *   node scripts/seed-test-engagement.mjs
 *   node scripts/seed-test-engagement.mjs --db data.db --keep
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";

// ---------- 常量 ----------

/** 测试数据标记域名：清理与识别都靠它。 */
const TEST_EMAIL_DOMAIN = "test.suda.im";
const PLUGIN_ID = "pulse-subscriptions";
const SUBSCRIBERS_COLLECTION = "subscribers";
const GROUPS_COLLECTION = "groups";
const EVENTS_COLLECTION = "events";

// ---------- 参数 ----------

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const argValue = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DB_PATH = argValue("--db", "data.db");
const KEEP = hasFlag("--keep");

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

const testEmail = (local) => `${local}@${TEST_EMAIL_DOMAIN}`;

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------- 测试内容 ----------

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

// ---------- 生成 ----------

/** 把线程递归展开成扁平的评论行（含 parent_id）。 */
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
				author_email: testEmail(item.email),
				body: item.body,
				status: "approved",
				ip_hash: null,
				user_agent: "seed-test-engagement",
				moderation_metadata: JSON.stringify({ source: "seed-test", decision: "approved" }),
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
	const email = testEmail(spec.local);
	const createdAtMs =
		(spec.daysAgo ?? 0) * DAY + (spec.hoursAgo ?? 0) * HOUR;
	const createdAt = iso(createdAtMs);
	// paused 只从 confirmed 进入（见 operations.ts），所以它也带 confirmedAt。
	const confirmedAt =
		spec.status === "confirmed" || spec.status === "unsubscribed" || spec.status === "paused"
			? iso(createdAtMs - 2 * MINUTE)
			: undefined;
	const unsubscribedAt =
		spec.unsubDaysAgo != null ? iso(spec.unsubDaysAgo * DAY) : undefined;
	const pausedAt = spec.pauseDaysAgo != null ? iso(spec.pauseDaysAgo * DAY) : undefined;

	// 确认 / 退订 token 只存哈希，明文仅在邮件链接里；测试数据用随机值占位。
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
		...(pausedAt
			? { pausedAt, pausedBy: "admin", pausedFrom: "confirmed" }
			: {}),
		...(spec.pauseReason ? { pauseReason: spec.pauseReason } : {}),
	};
	if (spec.undelivered) {
		record.pendingEmail = {
			to: email,
			subject: "确认订阅 Suda Pulse",
			text: "（测试数据）点击链接确认订阅。",
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
		push("paused", record.pausedAt, "admin", { ...(record.pauseReason ? { reason: record.pauseReason } : {}) });
	}
	if (spec.status === "unsubscribed") {
		push("unsubscribed", record.unsubscribedAt, "reader", {
			...(record.unsubscribeReason ? { reason: record.unsubscribeReason } : {}),
		});
	}
	return events;
}

// ---------- 主流程 ----------

function main() {
	const db = new DatabaseSync(DB_PATH);
	db.exec("PRAGMA busy_timeout = 5000;");

	const published = db
		.prepare("SELECT id, slug FROM ec_articles WHERE status = 'published'")
		.all();
	const idBySlug = new Map(published.map((row) => [row.slug, row.id]));

	if (!KEEP) {
		// 先计数再删：评论表有自引用外键（on delete cascade），
		// 直接删父评论会级联删回复，`changes` 只统计被直接删除的行。
		const commentCount = db
			.prepare("SELECT count(*) AS n FROM _emdash_comments WHERE author_email LIKE ?")
			.get(`%@${TEST_EMAIL_DOMAIN}`).n;
		db.prepare("DELETE FROM _emdash_comments WHERE author_email LIKE ?").run(
			`%@${TEST_EMAIL_DOMAIN}`,
		);

		const subCount = db
			.prepare(
				"SELECT count(*) AS n FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND json_extract(data, '$.email') LIKE ?",
			)
			.get(PLUGIN_ID, SUBSCRIBERS_COLLECTION, `%@${TEST_EMAIL_DOMAIN}`).n;
		db.prepare(
			"DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND json_extract(data, '$.email') LIKE ?",
		).run(PLUGIN_ID, SUBSCRIBERS_COLLECTION, `%@${TEST_EMAIL_DOMAIN}`);

		// 分组：只清本脚本声明的 slug（后台可能手工建过别的分组）。
		const groupSlugs = GROUPS.map((group) => group.slug);
		const groupCount = db
			.prepare(
				`SELECT count(*) AS n FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id IN (${groupSlugs.map(() => "?").join(", ")})`,
			)
			.get(PLUGIN_ID, GROUPS_COLLECTION, ...groupSlugs).n;
		db.prepare(
			`DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id IN (${groupSlugs.map(() => "?").join(", ")})`,
		).run(PLUGIN_ID, GROUPS_COLLECTION, ...groupSlugs);

		// 事件：只由这些测试订阅者产生，按插件整段清空。
		const eventCount = db
			.prepare(
				"SELECT count(*) AS n FROM _plugin_storage WHERE plugin_id = ? AND collection = ?",
			)
			.get(PLUGIN_ID, EVENTS_COLLECTION).n;
		db.prepare(
			"DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = ?",
		).run(PLUGIN_ID, EVENTS_COLLECTION);

		console.log(
			`清理旧测试数据：评论 ${commentCount} 条，订阅者 ${subCount} 条，分组 ${groupCount} 个，事件 ${eventCount} 条`,
		);
	}

	// ---- 评论 ----
	const insertComment = db.prepare(
		`INSERT INTO _emdash_comments
		 (id, collection, content_id, parent_id, author_name, author_email, body, status,
		  ip_hash, user_agent, moderation_metadata, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	let commentCount = 0;
	const perArticle = [];
	for (const [slug, threads] of Object.entries(COMMENT_THREADS)) {
		const contentId = idBySlug.get(slug);
		if (!contentId) {
			console.warn(`跳过评论：找不到已发布文章 ${slug}`);
			continue;
		}
		const rows = flattenThreads(threads, contentId, 2 * DAY);
		for (const row of rows) {
			insertComment.run(
				row.id,
				row.collection,
				row.content_id,
				row.parent_id,
				row.author_name,
				row.author_email,
				row.body,
				row.status,
				row.ip_hash,
				row.user_agent,
				row.moderation_metadata,
				row.created_at,
				row.updated_at,
			);
		}
		commentCount += rows.length;
		perArticle.push(`${slug} (${rows.length})`);
	}

	// ---- 订阅分组 ----
	const insertStorage = db.prepare(
		`INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);

	let groupCount = 0;
	for (const spec of GROUPS) {
		const { id, data } = buildGroupRecord(spec);
		insertStorage.run(
			PLUGIN_ID,
			GROUPS_COLLECTION,
			id,
			JSON.stringify(data),
			data.createdAt,
			data.createdAt,
		);
		groupCount += 1;
	}

	// ---- 订阅者 + 事件日志 ----
	let subCount = 0;
	let eventCount = 0;
	const byStatus = { confirmed: 0, pending: 0, unsubscribed: 0, paused: 0 };
	for (const spec of SUBSCRIBERS) {
		const { id, data } = buildSubscriberRecord(spec);
		insertStorage.run(
			PLUGIN_ID,
			SUBSCRIBERS_COLLECTION,
			id,
			JSON.stringify(data),
			data.createdAt,
			data.createdAt,
		);
		subCount += 1;
		byStatus[data.status] += 1;

		for (const event of buildEvents(spec, id, data)) {
			insertStorage.run(
				PLUGIN_ID,
				EVENTS_COLLECTION,
				event.id,
				JSON.stringify(event.data),
				event.data.at,
				event.data.at,
			);
			eventCount += 1;
		}
	}

	db.close();

	console.log(`\n写入完成：`);
	console.log(`  评论 ${commentCount} 条 —— ${perArticle.join("、")}`);
	console.log(
		`  订阅者 ${subCount} 条 —— confirmed ${byStatus.confirmed} / pending ${byStatus.pending} / paused ${byStatus.paused} / unsubscribed ${byStatus.unsubscribed}`,
	);
	console.log(`  分组 ${groupCount} 个 —— ${GROUPS.map((group) => group.slug).join("、")}`);
	console.log(`  事件 ${eventCount} 条`);
	console.log(
		`\n前台：/articles/<slug> 评论区、/subscribe 分组勾选、订阅管理页；后台：/_emdash/admin/plugins/${PLUGIN_ID}`,
	);
}

main();
