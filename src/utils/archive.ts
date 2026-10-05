/**
 * 归档索引：从已发布文章中推导出「哪些年 / 月 / ISO 周」有内容，
 * 供 ArchiveNav 生成年份与期间选项、以及 /archive 首页时间线。
 */

import { getEmDashCollection } from "emdash";
import type { CacheHint } from "emdash";
import { isoWeekOf } from "./format";

export interface ArchivePeriod {
	year: number;
	months: number[];
	weeks: number[];
}

export interface ArchiveIndex {
	years: number[];
	byYear: Map<number, ArchivePeriod>;
	cacheHint?: CacheHint;
}

export async function getArchiveIndex(limit = 500): Promise<ArchiveIndex> {
	const { entries, cacheHint } = await getEmDashCollection("articles", {
		orderBy: { published_at: "desc" },
		limit,
	});

	const byYear = new Map<number, ArchivePeriod>();
	for (const entry of entries) {
		const date = entry.data.publishedAt ? new Date(entry.data.publishedAt) : null;
		if (!date || Number.isNaN(date.getTime())) continue;
		const year = date.getFullYear();
		const month = date.getMonth() + 1;
		const iso = isoWeekOf(date);
		if (!byYear.has(year)) byYear.set(year, { year, months: [], weeks: [] });
		const period = byYear.get(year)!;
		if (!period.months.includes(month)) period.months.push(month);
		if (iso && !period.weeks.includes(iso.week)) period.weeks.push(iso.week);
	}

	for (const period of byYear.values()) {
		period.months.sort((a, b) => a - b);
		period.weeks.sort((a, b) => a - b);
	}

	const years = [...byYear.keys()].sort((a, b) => b - a);
	return { years, byYear, cacheHint };
}
