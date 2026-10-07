/**
 * XML 转义（sitemap 与 RSS 共用）。
 *
 * 机器端点都是手写字符串拼 XML，转义逻辑只放这一处，避免各端点各抄一份。
 */

const XML_ESCAPE_PATTERNS = [
	[/&/g, "&amp;"],
	[/</g, "&lt;"],
	[/>/g, "&gt;"],
	[/"/g, "&quot;"],
	[/'/g, "&apos;"],
] as const;

export function escapeXml(str: string): string {
	let result = str;
	for (const [pattern, replacement] of XML_ESCAPE_PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}
