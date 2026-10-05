import { afterEach, describe, expect, it } from "vitest";

import { createPluginTestHost, type PluginTestHost } from "@emdash-cms/plugin-test";

let host: PluginTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

const baseEvent = (reviewStatus: string, collection = "articles") => ({
	collection,
	origin: "api",
	content: { data: { review_status: reviewStatus } },
});

describe("pulse-review publish policy", () => {
	it("rejects publishing an article that is not approved", async () => {
		host = await createPluginTestHost();
		const result = await host.invokeHook("content:beforePublish", baseEvent("pending_review"));
		expect(result).toMatchObject({ cancel: true });
	});

	it("allows publishing an approved article", async () => {
		host = await createPluginTestHost();
		const result = await host.invokeHook("content:beforePublish", baseEvent("approved"));
		expect(result == null).toBe(true);
	});

	it("ignores other collections", async () => {
		host = await createPluginTestHost();
		const result = await host.invokeHook("content:beforePublish", baseEvent("draft", "pages"));
		expect(result == null).toBe(true);
	});

	it("rejects scheduling an article that is not approved", async () => {
		host = await createPluginTestHost();
		const result = await host.invokeHook("content:beforeSchedule", baseEvent("draft"));
		expect(result).toMatchObject({ cancel: true });
	});
});
