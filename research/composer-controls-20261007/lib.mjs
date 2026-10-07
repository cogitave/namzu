import { createRequire } from "node:module";
export const { chromium } = createRequire(
	new URL("../../packages/desktop/package.json", import.meta.url).pathname,
)("@playwright/test");
export const S = new URL("./artifacts", import.meta.url).pathname;
export async function open(
	browser,
	{ width = 1280, height = 900, scheme = "dark", engine = "namzu" } = {},
) {
	const page = await browser.newPage({
		viewport: { width, height },
		colorScheme: scheme,
	});
	page.setDefaultTimeout(8000);
	page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
	await page.goto("http://127.0.0.1:5173/preview");
	await page.waitForTimeout(1200);
	if (engine !== "namzu") {
		await page.locator('button[aria-label="Execution engine"]').click();
		await page
			.getByRole("radio", { name: engine === "codex-cli" ? /Codex/ : /Claude/ })
			.click();
		await page.waitForTimeout(800);
		await page
			.locator(".conversation-row-title:visible", { hasText: "Sample draft" })
			.first()
			.click();
		await page.waitForTimeout(1500);
	}
	return page;
}
