/**
 * `getEmDashCollection` 的 `where` 子句辅助。
 *
 * EmDash 的布尔字段（`FIELD_TYPE_TO_COLUMN` → INTEGER，写入 0/1）在**运行时**是
 * 支持 `where` 过滤的：`buildFieldConditions` 里的 `bindableFilterValue` 会把
 * `true` / `false` 归一化成 `1` / `0`（见 emdash dist loader，注释明确说明这是
 * 为了兼容 PostgreSQL 的 INTEGER 列）。
 *
 * 但 1.1.0 的公共类型是 `type WhereValue = string | string[] | WhereRange`，
 * 漏掉了 `boolean` —— 直接写 `where: { is_featured: true }` 会报 ts(2322)。
 * 这里在调用点做一次显式收窄，既保留调用处的类型提示（只允许字符串 / 字符串数组 /
 * 区间 / 布尔），又不必到处写 `as unknown as`。
 *
 * 注意：**必须传原生布尔值**。传字符串 `"true"` 不会命中——SQLite 会拿字符串去比
 * INTEGER 列（值 0/1），结果恒为假。
 */

import type { WhereValue } from "emdash";

export function whereClause(filters: Record<string, WhereValue | boolean>): Record<string, WhereValue> {
	return filters as Record<string, WhereValue>;
}
