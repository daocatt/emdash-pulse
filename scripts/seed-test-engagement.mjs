#!/usr/bin/env node
/**
 * 本地测试数据：一批评论 + 一批订阅者（仅用于 dev 复核 UI）。
 *
 * - 评论：写入 `_emdash_comments`（全部 `status='approved'`，含楼中楼回复），
 *   落到几篇已发布文章上，前台文章页评论区立即可见。
 * - 订阅者：写入插件存储 `_plugin_storage`
 *   （`pulse-subscriptions` / `subscribers`），状态混合
 *   `confirmed` / `pending` / `unsubscribed`，供后台「读者订阅」页复核。
 *
 * 幂等：默认先按邮箱标记（`@test.suda.im`）清除上一次的测试数据再写入；
 * 加 `--keep` 则只追加不清除。
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

/** 订阅者：状态混合，个别带「待发邮件」快照以覆盖后台不同展示。 */
const SUBSCRIBERS = [
	{ local: "linyi", status: "confirmed", source: "web", daysAgo: 21 },
	{ local: "zhouzhou", status: "confirmed", source: "web", daysAgo: 18 },
	{ local: "chenmo", status: "confirmed", source: "article", daysAgo: 12 },
	{ local: "suwan", status: "confirmed", source: "web", daysAgo: 9 },
	{ local: "kevin", status: "confirmed", source: "footer", daysAgo: 6 },
	{ local: "zhaoqing", status: "confirmed", source: "web", daysAgo: 3 },
	{ local: "lirang", status: "pending", source: "web", daysAgo: 2 },
	{ local: "wangan", status: "pending", source: "article", daysAgo: 1 },
	{ local: "hesu", status: "pending", source: "web", hoursAgo: 8 },
	// 邮件未投递（无 provider / 投递失败）时保留的待发快照。
	{ local: "nina", status: "pending", source: "web", hoursAgo: 5, undelivered: true },
	{ local: "mika", status: "unsubscribed", source: "web", daysAgo: 30, unsubDaysAgo: 4 },
	{ local: "oliver", status: "unsubscribed", source: "web", daysAgo: 45, unsubDaysAgo: 11 },
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
	const confirmedAt =
		spec.status === "confirmed" || spec.status === "unsubscribed"
			? iso(createdAtMs - 2 * MINUTE)
			: undefined;
	const unsubscribedAt =
		spec.unsubDaysAgo != null ? iso(spec.unsubDaysAgo * DAY) : undefined;

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
		createdAt,
		requestedAt: createdAt,
		emailDelivered: !spec.undelivered,
		lastSentAt: createdAt,
		...(confirmedAt ? { confirmedAt } : {}),
		...(unsubscribedAt ? { unsubscribedAt } : {}),
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

		console.log(`清理旧测试数据：评论 ${commentCount} 条，订阅者 ${subCount} 条`);
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

	// ---- 订阅者 ----
	const insertSub = db.prepare(
		`INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);

	let subCount = 0;
	const byStatus = { confirmed: 0, pending: 0, unsubscribed: 0 };
	for (const spec of SUBSCRIBERS) {
		const { id, data } = buildSubscriberRecord(spec);
		insertSub.run(
			PLUGIN_ID,
			SUBSCRIBERS_COLLECTION,
			id,
			JSON.stringify(data),
			data.createdAt,
			data.createdAt,
		);
		subCount += 1;
		byStatus[data.status] += 1;
	}

	db.close();

	console.log(`\n写入完成：`);
	console.log(`  评论 ${commentCount} 条 —— ${perArticle.join("、")}`);
	console.log(
		`  订阅者 ${subCount} 条 —— confirmed ${byStatus.confirmed} / pending ${byStatus.pending} / unsubscribed ${byStatus.unsubscribed}`,
	);
	console.log(
		`\n前台：/articles/<slug> 评论区；后台：/_emdash/admin/plugins/${PLUGIN_ID}`,
	);
}

main();
