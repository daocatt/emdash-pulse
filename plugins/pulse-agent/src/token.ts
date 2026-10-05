/**
 * Agent 凭证：生成、哈希、校验。
 *
 * token 形如 `sp_<slug>_<random>`，**只把 SHA-256 哈希**存进插件存储；
 * 明文仅在审批通过时返回一次，由管理员转交给对应 agent。
 *
 * 沙箱内可用 WebCrypto（`crypto.randomUUID` / `crypto.subtle`），
 * 不依赖 Node 内置模块。
 */

const encoder = new TextEncoder();

const hex = (buffer: ArrayBuffer): string =>
	[...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** 生成 agent token（明文）。 */
export function generateAgentToken(slug: string): string {
	const a = crypto.randomUUID().replace(/-/g, "");
	const b = crypto.randomUUID().replace(/-/g, "");
	return `sp_${slug}_${a}${b}`;
}

/** 生成一次性注册密钥（明文）。 */
export function generateRegistrationSecret(): string {
	return `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

/** SHA-256 十六进制摘要。 */
export async function hashSecret(value: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** 恒定时间字符串比较（workerd 无 crypto.timingSafeEqual）。 */
export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** token 前缀（用于后台展示，不含完整密钥）。 */
export function tokenPrefix(token: string): string {
	return token.slice(0, 12);
}
