/**
 * 订阅邮件的构建与投递。
 *
 * 邮件内容是纯函数（便于单测）；投递走 `ctx.email`（需 `email:send` 能力 +
 * 已配置 provider）。**provider 缺失或投递失败时不抛错**，而是返回
 * `{ delivered: false, reason }`，由调用方落库为 `pendingEmail` 待发。
 */

/** 与 EmDash `EmailMessage` 形状一致（本地声明以避免依赖未导出的内部类型）。 */
export interface EmailMessage {
	to: string;
	cc?: string[];
	replyTo?: string;
	subject: string;
	text: string;
	html?: string;
}

/** `ctx.email` 的最小可用接口。 */
export interface EmailSender {
	send(message: EmailMessage): Promise<void>;
}

export interface DeliveryResult {
	delivered: boolean;
	reason?: string;
}

/** 投递邮件；未配置 provider 或失败时降级为 `{ delivered: false }`。 */
export async function deliver(email: EmailSender | undefined, message: EmailMessage): Promise<DeliveryResult> {
	if (!email) return { delivered: false, reason: "email_provider_not_configured" };
	try {
		await email.send(message);
		return { delivered: true };
	} catch (error) {
		return { delivered: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

export interface MailBrand {
	siteName: string;
	replyTo?: string;
}

/** 确认订阅邮件（含一次性确认链接）。 */
export function buildConfirmEmail(
	input: { to: string; confirmUrl: string; subject?: string } & MailBrand,
): EmailMessage {
	const subject = input.subject?.trim() || "确认订阅 " + input.siteName;
	const text = [
		`感谢订阅 ${input.siteName}。`,
		"",
		"请点击下面的链接确认订阅（链接一次有效）：",
		input.confirmUrl,
		"",
		"如果这不是你本人的操作，忽略本邮件即可。",
	].join("\n");

	return {
		to: input.to,
		...(input.replyTo ? { replyTo: input.replyTo } : {}),
		subject,
		text,
		html: `<p>感谢订阅 <strong>${escapeHtml(input.siteName)}</strong>。</p>
<p>请点击下面的链接确认订阅（链接一次有效）：</p>
<p><a href="${escapeHtml(input.confirmUrl)}">确认订阅</a></p>
<p>如果这不是你本人的操作，忽略本邮件即可。</p>`,
	};
}

/** 欢迎邮件（订阅确认后发出，含退订链接）。 */
export function buildWelcomeEmail(
	input: { to: string; unsubscribeUrl: string; subject?: string } & MailBrand,
): EmailMessage {
	const subject = input.subject?.trim() || "欢迎订阅 " + input.siteName;
	const text = [
		`你已成功订阅 ${input.siteName}。`,
		"",
		"我们会在有新内容时通知你。",
		"",
		`如需退订，请访问：${input.unsubscribeUrl}`,
	].join("\n");

	return {
		to: input.to,
		...(input.replyTo ? { replyTo: input.replyTo } : {}),
		subject,
		text,
		html: `<p>你已成功订阅 <strong>${escapeHtml(input.siteName)}</strong>。</p>
<p>我们会在有新内容时通知你。</p>
<p>如需退订，请<a href="${escapeHtml(input.unsubscribeUrl)}">点此退订</a>。</p>`,
	};
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** 拼接绝对链接（`base` 来自 `ctx.url()`，可能已带查询串）。 */
export function linkWithToken(base: string, token: string): string {
	const sep = base.includes("?") ? "&" : "?";
	return `${base}${sep}token=${encodeURIComponent(token)}`;
}
