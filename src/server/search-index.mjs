/**
 * PG 全文搜索索引（`pg_trgm`）。
 *
 * 背景：EmDash 的全文搜索建在 SQLite FTS5 上，非 SQLite 方言下**完全失效**
 * （见 docs/16-vps-deployment.md）。迁到 PostgreSQL 后，本站用一张自有的
 * `pulse_search` 表 + `pg_trgm` 的 GIN trigram 索引重建中文子串检索 —— 这与原先
 * FTS5 `trigram` 分词器的语义一致（按字符子串匹配，适合中文）。
 *
 * 设计要点：
 * - **自有连接池**：不依赖 EmDash 的 Kysely 句柄，直接用 `pg`（`DATABASE_URL` 或标准
 *   libpq 变量 PG*），这样后台刷新与 CLI 脚本走同一条代码路径。
 * - **懒建 + 懒刷新**：`ensureAndRefreshIndex()` 首次调用建表/建索引并同步一次，
 *   之后按 `TTL_MS` 节流后台刷新；用 PG advisory lock 防并发重建。
 * - **失败不致命**：任何异常都降级为空结果 / 跳过刷新，绝不让搜索拖垮页面。
 *
 * 该模块是纯 ESM JS（非 TS），以便被 Astro 端点和 `scripts/search-rebuild.mjs` 共用。
 */
import { Pool } from "pg";

const TABLE = "pulse_search";
const TTL_MS = 5 * 60 * 1000;
/** advisory lock 的键（任取一个稳定的 64 位整数）。 */
const LOCK_KEY = 918273645;

/** 从 Portable Text / 嵌套 JSON 中提取纯文本（与 EmDash `extractPlainText` 同义）。 */
const PROSE_KEYS = new Set(["text", "alt", "caption", "code"]);

export function extractPlainText(value) {
	if (value == null) return "";
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
			try {
				return extractPlainText(JSON.parse(trimmed));
			} catch {
				return value;
			}
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(extractPlainText).filter(Boolean).join(" ");
	}
	if (typeof value === "object") {
		const parts = [];
		for (const [key, child] of Object.entries(value)) {
			if (PROSE_KEYS.has(key) && typeof child === "string") parts.push(child);
			else if (child && typeof child === "object") parts.push(extractPlainText(child));
		}
		return parts.filter(Boolean).join(" ");
	}
	return "";
}

// ---------- 连接池（进程内单例，跨 HMR 复用） ----------

function getPool() {
	const g = globalThis;
	if (!g.__pulseSearchPool) {
		const pool = new Pool(
			process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {},
		);
		pool.on("error", (error) => {
			console.warn(`[search] pg pool error: ${error?.message ?? error}`);
		});
		g.__pulseSearchPool = pool;
	}
	return g.__pulseSearchPool;
}

/** 关闭单例连接池（CLI 脚本用；服务进程不需要调用）。 */
export async function closeSearchPool() {
	const g = globalThis;
	const pool = g.__pulseSearchPool;
	if (!pool) return;
	g.__pulseSearchPool = undefined;
	try {
		await pool.end();
	} catch {
		/* 忽略关闭错误 */
	}
}

// ---------- schema ----------
const DDL = [
	`CREATE EXTENSION IF NOT EXISTS pg_trgm`,
	`CREATE TABLE IF NOT EXISTS ${TABLE} (
		collection text NOT NULL,
		entry_id text NOT NULL,
		slug text,
		title text NOT NULL DEFAULT '',
		body text NOT NULL DEFAULT '',
		published_at timestamptz,
		updated_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (collection, entry_id)
	)`,
	`CREATE INDEX IF NOT EXISTS ${TABLE}_title_trgm ON ${TABLE} USING gin (title gin_trgm_ops)`,
	`CREATE INDEX IF NOT EXISTS ${TABLE}_body_trgm ON ${TABLE} USING gin (body gin_trgm_ops)`,
];

let schemaPromise;
function ensureSchema(pool) {
	if (!schemaPromise) {
		schemaPromise = (async () => {
			for (const statement of DDL) await pool.query(statement);
		})().catch((error) => {
			schemaPromise = undefined; // 允许下次重试
			throw error;
		});
	}
	return schemaPromise;
}

// ---------- 重建 ----------

/** 目标集合：`{ collection, table }`。表名固定，不来自用户输入。 */
const SOURCES = [
	{ collection: "articles", table: "ec_articles" },
	{ collection: "pages", table: "ec_pages" },
];

async function tableColumns(pool, table) {
	const { rows } = await pool.query(
		"SELECT column_name FROM information_schema.columns WHERE table_name = $1",
		[table],
	);
	return new Set(rows.map((row) => row.column_name));
}

function buildSourceQuery(table, columns) {
	const pick = (name, fallback = "NULL") => (columns.has(name) ? `"${name}"` : fallback);
	const select = [
		`"id" AS id`,
		pick("slug") + " AS slug",
		pick("title", "''") + " AS title",
		pick("deck", "''") + " AS deck",
		pick("excerpt", "''") + " AS excerpt",
		pick("content") + " AS content",
		pick("published_at") + " AS published_at",
	].join(", ");
	const where = ["deleted_at IS NULL"];
	if (columns.has("status")) where.push("status = 'published'");
	return `SELECT ${select} FROM "${table}" WHERE ${where.join(" AND ")}`;
}

/** 全量重建 `pulse_search`。并发时用 advisory lock 串行化。 */
export async function rebuildIndex() {
	const pool = getPool();
	await ensureSchema(pool);
	const client = await pool.connect();
	try {
		const { rows: lockRows } = await client.query(
			"SELECT pg_try_advisory_lock($1) AS locked",
			[LOCK_KEY],
		);
		if (!lockRows[0]?.locked) return { skipped: true };
		try {
			const records = [];
			for (const source of SOURCES) {
				let columns;
				try {
					columns = await tableColumns(client, source.table);
				} catch {
					continue;
				}
				if (columns.size === 0) continue; // 表还不存在（迁移未跑）
				const { rows } = await client.query(buildSourceQuery(source.table, columns));
				for (const row of rows) {
					const body = [row.deck, row.excerpt, extractPlainText(row.content)]
						.filter(Boolean)
						.join(" ");
					records.push({
						collection: source.collection,
						entry_id: row.id,
						slug: row.slug ?? null,
						title: row.title ?? "",
						body,
						published_at: row.published_at ?? null,
					});
				}
			}

			await client.query("BEGIN");
			await client.query(`DELETE FROM ${TABLE}`);
			for (const record of records) {
				await client.query(
					`INSERT INTO ${TABLE} (collection, entry_id, slug, title, body, published_at, updated_at)
					 VALUES ($1, $2, $3, $4, $5, $6, now())`,
					[
						record.collection,
						record.entry_id,
						record.slug,
						record.title,
						record.body,
						record.published_at,
					],
				);
			}
			await client.query("COMMIT");
			return { skipped: false, count: records.length };
		} finally {
			await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
		}
	} finally {
		client.release();
	}
}

let lastRebuildAt = 0;
let refreshing = null;

/**
 * 保证索引可用且不过期。首次调用**同步重建**（保证第一次搜索就有结果），
 * 之后超过 TTL 时**后台重建**（不阻塞当前请求）。失败一律吞掉。
 */
export async function ensureAndRefreshIndex() {
	try {
		await ensureSchema(getPool());
	} catch (error) {
		console.warn(`[search] 建索引表失败：${error?.message ?? error}`);
		return;
	}
	if (lastRebuildAt === 0) {
		await runRebuild();
		return;
	}
	if (Date.now() - lastRebuildAt > TTL_MS && !refreshing) {
		void runRebuild();
	}
}

function runRebuild() {
	if (refreshing) return refreshing;
	refreshing = rebuildIndex()
		.then((result) => {
			if (!result?.skipped) lastRebuildAt = Date.now();
		})
		.catch((error) => {
			console.warn(`[search] 重建索引失败：${error?.message ?? error}`);
		})
		.finally(() => {
			refreshing = null;
		});
	return refreshing;
}

// ---------- 查询 ----------

function escapeHtml(text) {
	return text.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

/** 在已转义的片段里给命中词加 `<mark>`（大小写不敏感，逐段转义避免注入）。 */
function highlight(rawText, query) {
	const text = rawText ?? "";
	if (!query) return escapeHtml(text);
	const needle = query.toLowerCase();
	const haystack = text.toLowerCase();
	const parts = [];
	let cursor = 0;
	while (cursor < text.length) {
		const index = haystack.indexOf(needle, cursor);
		if (index === -1) {
			parts.push(escapeHtml(text.slice(cursor)));
			break;
		}
		parts.push(escapeHtml(text.slice(cursor, index)));
		parts.push(`<mark>${escapeHtml(text.slice(index, index + query.length))}</mark>`);
		cursor = index + query.length;
	}
	return parts.join("");
}

/**
 * 搜索 `pulse_search`。返回 `{ collection, id, slug, title, snippet }[]`，
 * snippet 是已转义并带 `<mark>` 的 HTML 片段（页面用 `set:html` 渲染）。
 */
export async function searchContent(query, limit = 30) {
	const trimmed = query?.trim();
	if (!trimmed) return [];
	const pool = getPool();
	try {
		const pattern = `%${trimmed}%`;
		const { rows } = await pool.query(
			`SELECT collection, entry_id, slug, title,
				CASE
					WHEN position(lower($1) in lower(body)) > 0
					THEN substring(body from greatest(1, position(lower($1) in lower(body)) - 40) for 160)
					ELSE left(body, 160)
				END AS snippet
			FROM ${TABLE}
			WHERE title ILIKE $2 OR body ILIKE $2
			ORDER BY (title ILIKE $2) DESC, similarity(title, $1) DESC, published_at DESC NULLS LAST
			LIMIT $3`,
			[trimmed, pattern, limit],
		);
		return rows.map((row) => ({
			collection: row.collection,
			id: row.entry_id,
			slug: row.slug,
			title: row.title,
			snippet: highlight(row.snippet, trimmed),
		}));
	} catch (error) {
		console.warn(`[search] 查询失败：${error?.message ?? error}`);
		return [];
	}
}
