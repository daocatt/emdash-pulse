/**
 * 订阅 token 与邮箱标识：生成、哈希、规范化。
 *
 * - token（确认 / 退订）明文只出现在邮件链接里，存储**只留 SHA-256 哈希**；
 * - 邮箱以规范化后的 SHA-256 作为唯一标识（`emailHash`），同时保留明文以便投递。
 *
 * 沙箱内可用 WebCrypto（`crypto.randomUUID` / `crypto.subtle`），不依赖 Node 内置模块。
 */

const encoder = new TextEncoder();

const hex = (buffer: ArrayBuffer): string =>
	[...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** 生成订阅 token（明文），形如 `ps_confirm_<random>`。 */
export function generateToken(purpose: string): string {
	const a = crypto.randomUUID().replace(/-/g, "");
	const b = crypto.randomUUID().replace(/-/g, "");
	return `ps_${purpose}_${a}${b}`;
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

/** token 前缀（后台展示用，不含完整密钥）。 */
export function tokenPrefix(token: string): string {
	return token.slice(0, 12);
}

/** 邮箱规范化：去空白 + 转小写。 */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** 邮箱唯一标识（规范化后的 SHA-256）。 */
export async function hashEmail(email: string): Promise<string> {
	return hashSecret(normalizeEmail(email));
}
