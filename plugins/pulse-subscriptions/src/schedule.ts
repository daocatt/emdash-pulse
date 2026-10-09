/**
 * 摘要定时任务的注册 / 取消。
 *
 * EmDash 的插件 cron：`ctx.cron.schedule(name, { schedule })` 幂等 upsert（键为
 * `plugin_id` + `task_name`），状态落 `_emdash_cron_tasks` 表，Node 下由
 * `NodeCronScheduler` 驱动。**时区固定 UTC**（对齐 Workers），本站 CST = UTC+8。
 *
 * 任务名必须匹配 `^[a-zA-Z][a-zA-Z0-9_-]*$`（**不含冒号**），故用 `digest-weekly`
 * 而不是 `digest:weekly`。
 *
 * 注册时机：`plugin:activate`（首次安装 / 后台重新启用）。宿主**不是每次启动**都
 * 触发 activate（见 docs/17），所以后台「订阅摘要」页加载时会再调一次自愈。
 */

import type { PluginContext } from "emdash/plugin";

import { digestSchedule, readDigestSettings } from "./digest";
import { CADENCE_VALUES, type Cadence } from "./subscribers";

export const DIGEST_TASK_PREFIX = "digest-";

/** cron 任务名（`ctx.cron` 的键）。 */
export const digestTaskName = (cadence: Cadence): string => `${DIGEST_TASK_PREFIX}${cadence}`;

/** 从 cron 事件名解析节奏（非摘要任务返回 null）。 */
export function cadenceFromTaskName(name: string): Cadence | null {
	if (!name.startsWith(DIGEST_TASK_PREFIX)) return null;
	const value = name.slice(DIGEST_TASK_PREFIX.length);
	return (CADENCE_VALUES as readonly string[]).includes(value) ? (value as Cadence) : null;
}

/**
 * 让两个摘要任务的调度与当前设置一致（幂等）。
 *
 * - `digestEnabled` 为真 → upsert 每档任务；
 * - 为假 → 取消每档任务。
 *
 * 永不抛错：注册失败只记日志（cron 是旁路，不该拖垮插件激活）。
 */
export async function ensureDigestSchedules(ctx: PluginContext): Promise<void> {
	try {
		if (!ctx.cron) return;
		const settings = await readDigestSettings(ctx);

		for (const cadence of CADENCE_VALUES) {
			const name = digestTaskName(cadence);
			if (settings.enabled) {
				await ctx.cron.schedule(name, { schedule: digestSchedule(settings, cadence) });
			} else {
				await ctx.cron.cancel(name);
			}
		}
	} catch (error) {
		ctx.log.warn("digest schedule registration failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
