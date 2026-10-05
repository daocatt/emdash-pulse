import { describe, expect, it } from "vitest";

import { markdownToPortableText, portableTextToText, type PtNode } from "../src/markdown";

const styles = (nodes: PtNode[]): string[] => nodes.map((node) => (node._type === "block" ? node.style : node._type));

const textOf = (node: PtNode): string =>
	node._type === "block" ? node.children.map((child) => child.text).join("") : node.code;

describe("markdownToPortableText", () => {
	it("把标题与段落转成 block", () => {
		const nodes = markdownToPortableText("# 标题\n\n正文一段。");
		expect(styles(nodes)).toEqual(["h1", "normal"]);
		expect(textOf(nodes[0])).toBe("标题");
		expect(textOf(nodes[1])).toBe("正文一段。");
	});

	it("支持多级标题", () => {
		const nodes = markdownToPortableText("### 三级");
		expect(styles(nodes)).toEqual(["h3"]);
	});

	it("把无序列表转成 listItem=bullet", () => {
		const nodes = markdownToPortableText("- 甲\n- 乙");
		expect(nodes).toHaveLength(2);
		expect(nodes.every((n) => n._type === "block" && n.listItem === "bullet")).toBe(true);
	});

	it("把有序列表转成 listItem=number", () => {
		const nodes = markdownToPortableText("1. 甲\n2. 乙");
		expect(nodes.every((n) => n._type === "block" && n.listItem === "number")).toBe(true);
	});

	it("把引用转成 blockquote", () => {
		const nodes = markdownToPortableText("> 引用内容");
		expect(styles(nodes)).toEqual(["blockquote"]);
		expect(textOf(nodes[0])).toBe("引用内容");
	});

	it("把围栏代码块转成 code 块并保留语言", () => {
		const nodes = markdownToPortableText("```ts\nconst a = 1;\n```");
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({ _type: "code", language: "ts", code: "const a = 1;" });
	});

	it("解析行内粗体/斜体/代码标记", () => {
		const nodes = markdownToPortableText("这是 **粗体** 与 *斜体* 和 `代码`。");
		const block = nodes[0];
		if (block._type !== "block") throw new Error("expected block");
		const marks = block.children.flatMap((child) => child.marks ?? []);
		expect(marks).toContain("strong");
		expect(marks).toContain("em");
		expect(marks).toContain("code");
	});

	it("把链接转成 markDef + span marks", () => {
		const nodes = markdownToPortableText("见 [文档](https://example.com/a)。");
		const block = nodes[0];
		if (block._type !== "block") throw new Error("expected block");
		expect(block.markDefs).toHaveLength(1);
		expect(block.markDefs?.[0]).toMatchObject({ _type: "link", href: "https://example.com/a" });
		const key = block.markDefs?.[0]?._key;
		expect(block.children.some((child) => child.marks?.includes(key ?? ""))).toBe(true);
	});

	it("空 markdown 产出空数组", () => {
		expect(markdownToPortableText("   \n\n  ")).toEqual([]);
	});
});

describe("portableTextToText", () => {
	it("从 block 与 code 中提取纯文本", () => {
		const nodes = markdownToPortableText("# 标题\n\n正文。\n\n```\ncode here\n```");
		const text = portableTextToText(nodes);
		expect(text).toContain("标题");
		expect(text).toContain("正文。");
		expect(text).toContain("code here");
	});

	it("非数组输入返回空串", () => {
		expect(portableTextToText(null)).toBe("");
	});
});
