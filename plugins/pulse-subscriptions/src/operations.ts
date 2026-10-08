/**
 * 订阅状态流转的共享实现。
 *
 * 后台行级操作（暂停 / 恢复 / 退订 / 改分组）与私有路由 `subscribers/update`
 * 走的是同一批函数，避免两条路径各写一遍状态机。每个函数都会补一条事件日志。
 *
 * 约定：**事件日志是旁路** —— `recordEvent` 失败不影响主流程（记录已经落库）。
 */

import type { PluginContext } from "emdash/plugin";

import { recordEvent, type EventActor } from "./events";
import { sanitizeGroupSlugs } from "./groups";
import { syncSubscriber } from "./segments";
import {
	subscriberStore,
	type PausableStatus,
	type SubscriberRecord,
	type SubscriberStatus,
} from "./subscribers";

const isoNow = (): string => new Date().toISOString();

/**
 * 状态变更后把结果同步到 Resend（旁路，永不抛错，未配置时自动跳过）。
 *
 * 放在这里而不是各个调用方：后台行级操作与私有路由走的是**同一批**函数，
 * 这是唯一的状态变更收口处，漏一处就会出现「本地改了、Resend 没改」。
 */
async function afterChange(ctx: PluginContext, id: string, record: SubscriberRecord): Promise<void> {
	await syncSubscriber(ctx, { id, data: record });
}

export type OperationError = "NOT_FOUND" | "INVALID_STATE";

export type OperationResult =
	| { ok: true; record: SubscriberRecord }
	| { ok: false; error: OperationError };

const notFound = (): OperationResult => ({ ok: false, error: "NOT_FOUND" });
const invalidState = (): OperationResult => ({ ok: false, error: "INVALID_STATE" });

/** 只有 pending / confirmed 可以被暂停；unsubscribed 与 paused 都不行。 */
function isPausable(status: SubscriberStatus): status is PausableStatus {
	return status === "pending" || status === "confirmed";
}

const sameGroups = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((slug, index) => slug === b[index]);

/**
 * 后台暂停：保留记录、停止投递。进入 `paused` 时清掉待发邮件（那份确认信不该再发）。
 */
export async function pauseSubscriber(
	ctx: PluginContext,
	id: string,
	options: { by?: string; reason?: string } = {},
): Promise<OperationResult> {
	const store = subscriberStore(ctx);
	const current = await store.get(id);
	if (!current) return notFound();
	if (!isPausable(current.status)) return invalidState();

	const record: SubscriberRecord = {
		...current,
		status: "paused",
		pausedFrom: current.status,
		pausedAt: isoNow(),
		...(options.by ? { pausedBy: options.by } : {}),
		...(options.reason ? { pauseReason: options.reason } : {}),
	};
	delete record.pendingEmail;

	await store.put(id, record);
	await recordEvent(ctx, {
		subscriberId: id,
		type: "paused",
		actor: "admin",
		...(options.reason ? { reason: options.reason } : {}),
	});
	await afterChange(ctx, id, record);
	return { ok: true, record };
}

/** 恢复：还原到暂停前的状态（缺省 confirmed）。**只能后台调用** —— 读者重新提交订阅不会恢复。 */
export async function resumeSubscriber(
	ctx: PluginContext,
	id: string,
): Promise<OperationResult> {
	const store = subscriberStore(ctx);
	const current = await store.get(id);
	if (!current) return notFound();
	if (current.status !== "paused") return invalidState();

	const record: SubscriberRecord = {
		...current,
		status: current.pausedFrom ?? "confirmed",
	};
	delete record.pausedAt;
	delete record.pausedBy;
	delete record.pauseReason;
	delete record.pausedFrom;

	await store.put(id, record);
	await recordEvent(ctx, {
		subscriberId: id,
		type: "resumed",
		actor: "admin",
	});
	await afterChange(ctx, id, record);
	return { ok: true, record };
}

/**
 * 退订。后台与读者（邮件 token）共用。
 *
 * 已退订时幂等返回当前记录；`paused` 记录也允许被退订（后台强制退订）。
 */
export async function unsubscribeSubscriber(
	ctx: PluginContext,
	id: string,
	options: { actor: EventActor; reason?: string } = { actor: "system" },
): Promise<OperationResult> {
	const store = subscriberStore(ctx);
	const current = await store.get(id);
	if (!current) return notFound();
	if (current.status === "unsubscribed") return { ok: true, record: current };

	const record: SubscriberRecord = {
		...current,
		status: "unsubscribed",
		unsubscribedAt: isoNow(),
		...(options.reason ? { unsubscribeReason: options.reason } : {}),
	};
	delete record.pendingEmail;
	delete record.pausedAt;
	delete record.pausedBy;
	delete record.pauseReason;
	delete record.pausedFrom;

	await store.put(id, record);
	await recordEvent(ctx, {
		subscriberId: id,
		type: "unsubscribed",
		actor: options.actor,
		...(options.reason ? { reason: options.reason } : {}),
	});
	await afterChange(ctx, id, record);
	return { ok: true, record };
}

/**
 * 设置订阅分组。传入的 slug 会被收敛为「存在且启用」的集合；
 * 结果与当前一致时不写库、不记事件。
 */
export async function setSubscriberGroups(
	ctx: PluginContext,
	id: string,
	slugs: readonly string[],
	actor: EventActor,
): Promise<OperationResult> {
	const store = subscriberStore(ctx);
	const current = await store.get(id);
	if (!current) return notFound();

	const next = await sanitizeGroupSlugs(ctx, slugs);
	const before = current.groups ?? [];
	if (sameGroups(before, next)) return { ok: true, record: current };

	const record: SubscriberRecord = { ...current, groups: next };
	await store.put(id, record);
	await recordEvent(ctx, {
		subscriberId: id,
		type: "groups_changed",
		actor,
		detail: next.join(","),
	});
	await afterChange(ctx, id, record);
	return { ok: true, record };
}
