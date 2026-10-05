import { describe, expect, it, vi } from "vitest";

import {
	buildConfirmEmail,
	buildWelcomeEmail,
	deliver,
	linkWithToken,
	type EmailMessage,
} from "../src/mail";
import { maskEmail } from "../src/subscribers";
import { generateToken, hashEmail, hashSecret, normalizeEmail, safeEqual, tokenPrefix } from "../src/token";

describe("token / 邮箱标识", () => {
	it("normalizeEmail 去空白并转小写", () => {
		expect(normalizeEmail("  Reader@Example.COM ")).toBe("reader@example.com");
	});

	it("hashEmail 对大小写/空白不敏感", async () => {
		const a = await hashEmail("Reader@Example.com");
		const b = await hashEmail("  reader@example.com ");
		expect(a).toBe(b);
	});

	it("hashSecret 产出 SHA-256 十六进制", async () => {
		expect(await hashSecret("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it("safeEqual 比较等长字符串", () => {
		expect(safeEqual("abc", "abc")).toBe(true);
		expect(safeEqual("abc", "abd")).toBe(false);
		expect(safeEqual("abc", "abcd")).toBe(false);
	});

	it("generateToken 带用途前缀且每次不同", () => {
		const a = generateToken("confirm");
		const b = generateToken("confirm");
		expect(a.startsWith("ps_confirm_")).toBe(true);
		expect(a).not.toBe(b);
	});

	it("tokenPrefix 取前 12 位", () => {
		expect(tokenPrefix("ps_confirm_abcdefghij")).toBe("ps_confirm_a");
	});

	it("maskEmail 隐藏本地部分", () => {
		expect(maskEmail("reader@example.com")).toBe("r*****@example.com");
		expect(maskEmail("no-at-sign")).toBe("***");
	});
});

describe("邮件构建", () => {
	const brand = { siteName: "Suda Pulse", replyTo: "reply@suda.im" };

	it("确认邮件含确认链接与品牌", () => {
		const msg = buildConfirmEmail({ to: "a@b.com", confirmUrl: "https://x.test/c?token=t1", ...brand });
		expect(msg.to).toBe("a@b.com");
		expect(msg.replyTo).toBe("reply@suda.im");
		expect(msg.subject).toBe("确认订阅 Suda Pulse");
		expect(msg.text).toContain("https://x.test/c?token=t1");
		expect(msg.html).toContain("https://x.test/c?token=t1");
	});

	it("确认邮件支持自定义主题", () => {
		const msg = buildConfirmEmail({ to: "a@b.com", confirmUrl: "https://x.test/c", subject: "请确认", ...brand });
		expect(msg.subject).toBe("请确认");
	});

	it("欢迎邮件含退订链接", () => {
		const msg = buildWelcomeEmail({ to: "a@b.com", unsubscribeUrl: "https://x.test/u?token=t2", ...brand });
		expect(msg.subject).toBe("欢迎订阅 Suda Pulse");
		expect(msg.text).toContain("https://x.test/u?token=t2");
	});

	it("无 replyTo 时不带该字段", () => {
		const msg = buildConfirmEmail({ to: "a@b.com", confirmUrl: "https://x.test/c", siteName: "Suda Pulse" });
		expect("replyTo" in msg).toBe(false);
	});

	it("对 HTML 特殊字符转义", () => {
		const msg = buildWelcomeEmail({
			to: "a@b.com",
			unsubscribeUrl: "https://x.test/u?a=1&b=<2>",
			siteName: "A&B",
		});
		expect(msg.html).toContain("A&amp;B");
		expect(msg.html).toContain("a=1&amp;b=&lt;2&gt;");
	});

	it("linkWithToken 处理已有查询串", () => {
		expect(linkWithToken("https://x.test/c", "t1")).toBe("https://x.test/c?token=t1");
		expect(linkWithToken("https://x.test/c?lang=zh", "t1")).toBe("https://x.test/c?lang=zh&token=t1");
	});
});

describe("邮件投递降级", () => {
	const message: EmailMessage = { to: "a@b.com", subject: "s", text: "t" };

	it("未配置 provider 时返回 delivered:false 且不抛错", async () => {
		const result = await deliver(undefined, message);
		expect(result.delivered).toBe(false);
		expect(result.reason).toBe("email_provider_not_configured");
	});

	it("provider 抛错时降级为 delivered:false", async () => {
		const send = vi.fn().mockRejectedValue(new Error("smtp down"));
		const result = await deliver({ send }, message);
		expect(result.delivered).toBe(false);
		expect(result.reason).toBe("smtp down");
	});

	it("provider 正常时投递并透传消息", async () => {
		const send = vi.fn().mockResolvedValue(undefined);
		const result = await deliver({ send }, message);
		expect(result.delivered).toBe(true);
		expect(send).toHaveBeenCalledWith(message);
	});
});
