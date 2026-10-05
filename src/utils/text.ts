/**
 * 从 Portable Text / 嵌套 JSON 中提取纯文本。
 */

export function extractPlainText(node: unknown): string {
	if (!node) return "";
	if (typeof node === "string") return node;
	if (Array.isArray(node)) return node.map(extractPlainText).join(" ");
	if (typeof node === "object") {
		const record = node as Record<string, unknown>;
		if (typeof record.text === "string") return record.text;
		return Object.values(record).map(extractPlainText).join(" ");
	}
	return "";
}
