/**
 * Markdown → EmDash Portable Text（尽力而为）。
 *
 * 支持的语法：ATX 标题（`#`–`######`）、段落、无序/有序列表、
 * 引用（`>`）、围栏代码块（```）、行内 `**粗体**` / `*斜体*` / `` `代码` `` /
 * `~~删除线~~` / `[链接](url)`。图片不在此转换（需走媒体库）。
 *
 * 产出块样式与 EmDash 渲染器一致：`normal` / `h1`–`h6` / `blockquote`，
 * 列表用 `listItem: "bullet" | "number"`，代码块为 `_type: "code"`。
 */

export interface PtSpan {
	_type: "span";
	_key: string;
	text: string;
	marks?: string[];
}

export interface PtMarkDef {
	_key: string;
	_type: "link";
	href: string;
}

export interface PtBlock {
	_type: "block";
	_key: string;
	style: string;
	listItem?: "bullet" | "number";
	level?: number;
	children: PtSpan[];
	markDefs?: PtMarkDef[];
}

export interface PtCodeBlock {
	_type: "code";
	_key: string;
	code: string;
	language?: string;
}

export type PtNode = PtBlock | PtCodeBlock;

const keyId = (): string => `k${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

interface InlineMatch {
	text: string;
	marks: string[];
	link?: string;
}

interface InlinePattern {
	re: RegExp;
	build: (match: RegExpExecArray) => InlineMatch;
}

// 顺序即优先级：链接 > 粗体 > 删除线 > 行内代码 > 斜体。
const PATTERNS: InlinePattern[] = [
	{
		re: /\[([^\]]+)\]\(([^)\s]+)\)/,
		build: (m) => ({ text: m[1], marks: [], link: m[2] }),
	},
	{ re: /\*\*([\s\S]+?)\*\*/, build: (m) => ({ text: m[1], marks: ["strong"] }) },
	{ re: /~~([\s\S]+?)~~/, build: (m) => ({ text: m[1], marks: ["strike-through"] }) },
	{ re: /`([^`]+)`/, build: (m) => ({ text: m[1], marks: ["code"] }) },
	{ re: /\*([^*\n]+)\*/, build: (m) => ({ text: m[1], marks: ["em"] }) },
	{ re: /_([^_\n]+)_/, build: (m) => ({ text: m[1], marks: ["em"] }) },
];

function findEarliest(text: string): { index: number; match: RegExpExecArray; pattern: InlinePattern } | null {
	let best: { index: number; match: RegExpExecArray; pattern: InlinePattern } | null = null;
	for (const pattern of PATTERNS) {
		const match = pattern.re.exec(text);
		if (!match || match.index === undefined) continue;
		if (!best || match.index < best.index) best = { index: match.index, match, pattern };
	}
	return best;
}

function parseInline(text: string, marks: string[], defs: PtMarkDef[]): PtSpan[] {
	const spans: PtSpan[] = [];
	let rest = text;

	while (rest.length > 0) {
		const best = findEarliest(rest);
		if (!best) {
			if (rest.trim()) spans.push({ _type: "span", _key: keyId(), text: rest, marks: [...marks] });
			break;
		}

		if (best.index > 0) {
			const plain = rest.slice(0, best.index);
			if (plain.trim()) spans.push({ _type: "span", _key: keyId(), text: plain, marks: [...marks] });
		}

		const built = best.pattern.build(best.match);
		const nextMarks = [...marks];
		if (built.link) {
			const key = keyId();
			defs.push({ _key: key, _type: "link", href: built.link });
			nextMarks.push(key);
		} else {
			for (const mark of built.marks) if (!nextMarks.includes(mark)) nextMarks.push(mark);
		}

		spans.push(...parseInline(built.text, nextMarks, defs));
		rest = rest.slice(best.index + best.match[0].length);
	}

	return spans;
}

function blockNode(style: string, children: PtSpan[], defs: PtMarkDef[]): PtBlock {
	const node: PtBlock = { _type: "block", _key: keyId(), style, children };
	if (defs.length > 0) node.markDefs = defs;
	return node;
}

/** 把 markdown 文本转换为 Portable Text 块数组。 */
export function markdownToPortableText(markdown: string): PtNode[] {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const nodes: PtNode[] = [];
	let paragraph: string[] = [];
	let i = 0;

	const flushParagraph = (): void => {
		if (paragraph.length === 0) return;
		const text = paragraph.join(" ").trim();
		paragraph = [];
		if (!text) return;
		const defs: PtMarkDef[] = [];
		const children = parseInline(text, [], defs);
		if (children.length > 0) nodes.push(blockNode("normal", children, defs));
	};

	while (i < lines.length) {
		const trimmed = lines[i].trim();

		const fence = /^```(\w[\w+-]*)?\s*$/.exec(trimmed);
		if (fence) {
			flushParagraph();
			const language = fence[1] || undefined;
			const code: string[] = [];
			i += 1;
			while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
				code.push(lines[i]);
				i += 1;
			}
			i += 1; // 跳过结束围栏
			nodes.push({ _type: "code", _key: keyId(), code: code.join("\n"), language });
			continue;
		}

		if (!trimmed) {
			flushParagraph();
			i += 1;
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
		if (heading) {
			flushParagraph();
			const defs: PtMarkDef[] = [];
			const children = parseInline(heading[2].trim(), [], defs);
			if (children.length > 0) nodes.push(blockNode(`h${heading[1].length}`, children, defs));
			i += 1;
			continue;
		}

		const quote = /^>\s?(.*)$/.exec(trimmed);
		if (quote) {
			flushParagraph();
			const defs: PtMarkDef[] = [];
			const children = parseInline(quote[1].trim(), [], defs);
			if (children.length > 0) nodes.push(blockNode("blockquote", children, defs));
			i += 1;
			continue;
		}

		const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
		if (bullet) {
			flushParagraph();
			const defs: PtMarkDef[] = [];
			const children = parseInline(bullet[1].trim(), [], defs);
			if (children.length > 0) {
				nodes.push({ ...blockNode("normal", children, defs), listItem: "bullet", level: 1 });
			}
			i += 1;
			continue;
		}

		const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
		if (ordered) {
			flushParagraph();
			const defs: PtMarkDef[] = [];
			const children = parseInline(ordered[1].trim(), [], defs);
			if (children.length > 0) {
				nodes.push({ ...blockNode("normal", children, defs), listItem: "number", level: 1 });
			}
			i += 1;
			continue;
		}

		if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
			flushParagraph();
			i += 1;
			continue;
		}

		paragraph.push(trimmed);
		i += 1;
	}

	flushParagraph();
	return nodes;
}

/** 从 Portable Text 提取纯文本（用于生成摘要/校验）。 */
export function portableTextToText(nodes: unknown): string {
	if (!Array.isArray(nodes)) return "";
	const parts: string[] = [];
	for (const node of nodes) {
		if (!node || typeof node !== "object") continue;
		const record = node as { _type?: string; children?: unknown; code?: string };
		if (record._type === "code") {
			if (record.code) parts.push(record.code);
			continue;
		}
		if (Array.isArray(record.children)) {
			const text = record.children
				.map((child) => (child && typeof child === "object" ? (child as { text?: string }).text ?? "" : ""))
				.join("");
			if (text) parts.push(text);
		}
	}
	return parts.join("\n\n").trim();
}
