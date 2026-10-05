import type { SandboxedPlugin } from "emdash/plugin";

/**
 * pulse-review — Suda Pulse 编审策略。
 *
 * 核心规则：只有 review_status === "approved" 的文章才允许发布/定时发布。
 * 该策略对所有来源生效（Admin UI、REST、MCP、视觉编辑、插件、定时任务）。
 */

const ARTICLES = "articles";
const APPROVED = "approved";

function reviewStatusOf(content: unknown): unknown {
	if (!content || typeof content !== "object") return undefined;
	const data = (content as { data?: unknown }).data;
	if (!data || typeof data !== "object") return undefined;
	return (data as Record<string, unknown>).review_status;
}

const REJECT_REASON = "稿件需经编辑审核通过（review_status=approved）后方可发布。";

const plugin: SandboxedPlugin = {
	hooks: {
		"content:beforePublish": async (event) => {
			if (event.collection !== ARTICLES) return;
			if (reviewStatusOf(event.content) !== APPROVED) {
				return { cancel: true, reason: REJECT_REASON };
			}
		},
		"content:beforeSchedule": async (event) => {
			if (event.collection !== ARTICLES) return;
			if (reviewStatusOf(event.content) !== APPROVED) {
				return { cancel: true, reason: "定时发布前需先审核通过（review_status=approved）。" };
			}
		},
	},
};

export default plugin;
