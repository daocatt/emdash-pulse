import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [emdashPluginTest()],
	test: {
		// 沙箱 runner（workerd）启动较慢，放宽超时。
		testTimeout: 30_000,
		hookTimeout: 60_000,
	},
});
