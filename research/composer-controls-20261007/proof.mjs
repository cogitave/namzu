import assert from "node:assert/strict";
import { S, chromium, open } from "./lib.mjs";

const results = [];
let effortWidth = 0;
const ok = (name, detail = "") => {
	results.push(`PASS ${name} ${detail}`);
	console.log("PASS", name, detail);
};
const trig = (page) => page.locator("button.model-picker-trigger");
const label = (page) => trig(page).getAttribute("aria-label");
const popup = (page) => page.locator('[data-slot="popover-popup"]').last();
async function theme(page, value) {
	await page.evaluate((v) => {
		document.documentElement.classList.toggle("dark", v === "dark");
	}, value);
	await page.waitForTimeout(150);
}
async function shot(page, name) {
	const t = await trig(page).boundingBox();
	const p = await popup(page)
		.boundingBox()
		.catch(() => null);
	const box = p
		? {
				x: Math.min(t.x, p.x) - 24,
				y: Math.min(t.y, p.y) - 16,
				right: Math.max(t.x + t.width, p.x + p.width) + 24,
				bottom: Math.max(t.y + t.height, p.y + p.height) + 16,
			}
		: {
				x: t.x - 300,
				y: t.y - 40,
				right: t.x + t.width + 60,
				bottom: t.y + t.height + 24,
			};
	const vp = page.viewportSize();
	const x = Math.max(0, box.x);
	const y = Math.max(0, box.y);
	await page.screenshot({
		path: `${S}/${name}.png`,
		clip: {
			x,
			y,
			width: Math.min(vp.width - x, box.right - x),
			height: Math.min(vp.height - y, box.bottom - y),
		},
	});
}
// No visible descendant may leave the popup, and the popup must stay inside the window.
async function noClip(page, name) {
	const r = await page.evaluate(() => {
		const pop = [
			...document.querySelectorAll('[data-slot="popover-popup"]'),
		].at(-1);
		const b = pop.getBoundingClientRect();
		const bad = [];
		for (const el of pop.querySelectorAll("*")) {
			const e = el.getBoundingClientRect();
			if (
				!e.width ||
				!e.height ||
				el.closest("[hidden]") ||
				getComputedStyle(el).position === "fixed"
			)
				continue;
			if (
				el.closest(".model-picker-list") ||
				el.closest(".model-picker-feedback")
			)
				continue;
			if (e.left < b.left - 1 || e.right > b.right + 1)
				bad.push(`${el.className?.toString().slice(0, 40)} x`);
		}
		return {
			bad,
			inWindow:
				b.left >= 0 &&
				b.right <= innerWidth &&
				b.top >= 0 &&
				b.bottom <= innerHeight,
			w: Math.round(b.width),
			h: Math.round(b.height),
		};
	});
	assert.deepEqual(r.bad, [], `${name} clipped`);
	assert.ok(r.inWindow, `${name} popup is inside the window`);
	return r;
}
async function closed(page) {
	await page.waitForFunction(
		() => !document.querySelector('[data-slot="popover-popup"][data-open]'),
	);
}
const levelsOf = (page) => popup(page).locator(".composer-effort-stop").count();

const browser = await chromium.launch();
try {
	// ---- Namzu engine, dark 1280x900
	if (!process.env.SKIP_NAMZU) {
		const page = await open(browser);
		assert.equal(await label(page), "Model: Sample balanced, effort: Medium");
		ok("namzu trigger name", await label(page));
		await shot(page, "namzu-1-trigger");
		await trig(page).click();
		await page.waitForTimeout(400);
		assert.equal(await levelsOf(page), 3);
		const r = await noClip(page, "namzu effort");
		ok("namzu effort panel geometry", JSON.stringify(r));
		effortWidth = r.w;
		assert.equal(
			await page.evaluate(() =>
				document.activeElement?.getAttribute("aria-label"),
			),
			"Effort",
		);
		ok("slider focused on open");
		await shot(page, "namzu-2-effort-medium");
		const reset = popup(page).getByRole("button", {
			name: "Use default effort",
		});
		assert.ok(await reset.isDisabled());
		ok("reset disabled at default");
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(250);
		assert.equal(await label(page), "Model: Sample balanced, effort: High");
		ok("ArrowRight commits one level");
		assert.ok(await reset.isEnabled());
		await page.keyboard.press("Home");
		await page.waitForTimeout(250);
		assert.match(await label(page), /effort: Low/);
		ok("Home jumps to first");
		await page.keyboard.press("End");
		await page.waitForTimeout(250);
		assert.match(await label(page), /effort: High/);
		ok("End jumps to last");
		assert.equal(
			await popup(page)
				.locator("input[type=range]")
				.getAttribute("aria-valuetext"),
			"High",
		);
		ok("aria-valuetext");
		await shot(page, "namzu-3-effort-high");
		await reset.click();
		await page.waitForTimeout(300);
		assert.match(await label(page), /effort: Medium/);
		ok("reset returns to default");
		await page.keyboard.press("Escape");
		await page.waitForTimeout(400);
		assert.equal(await page.locator('[data-slot="popover-popup"]').count(), 0);
		assert.equal(
			await page.evaluate(() =>
				document.activeElement?.classList.contains("model-picker-trigger"),
			),
			true,
		);
		ok("Escape closes, focus returns to trigger");
		// model list through the panel
		await trig(page).click();
		await page.waitForTimeout(300);
		await popup(page)
			.getByRole("button", { name: /change model/ })
			.click();
		await page.waitForTimeout(400);
		assert.ok(
			await popup(page).getByRole("button", { name: "Effort" }).isVisible(),
		);
		ok("back button present from panel");
		await shot(page, "namzu-4-models-from-effort");
		await noClip(page, "namzu models");
		await popup(page).getByRole("button", { name: "Effort" }).click();
		await page.waitForTimeout(300);
		assert.equal(await levelsOf(page), 3);
		ok("back returns to effort panel");
		await page.keyboard.press("Escape");
		await page.close();
	}
	// ---- Engines
	for (const engine of (process.env.ENGINES ?? "codex-cli,claude-code")
		.split(",")
		.filter(Boolean)) {
		const page = await open(browser, { engine });
		const tag = engine === "codex-cli" ? "codex" : "claude";
		const top = engine === "codex-cli" ? "GPT-6.1 Sol" : "Sonnet 5.5";
		const second = engine === "codex-cli" ? "GPT-5.6 Sol" : "Opus 5.5";
		const none = engine === "codex-cli" ? "GPT-5.5" : "Haiku 5";
		const back = engine === "codex-cli" ? "GPT-6.1 Sol" : "Sonnet 5.5";
		assert.match(
			await label(page),
			new RegExp(`^Model: ${top}, effort: Medium$`),
		);
		ok(`${tag} trigger`, await label(page));
		assert.equal(
			await trig(page)
				.locator("svg:not([data-composer-control-chevron])")
				.count(),
			0,
		);
		ok(`${tag} no provider icon in trigger`);
		await shot(page, `${tag}-1-trigger`);
		await trig(page).click();
		await page.waitForTimeout(400);
		await shot(page, `${tag}-2-effort`);
		await popup(page)
			.getByRole("button", { name: /change model/ })
			.click();
		await page.waitForTimeout(500);
		await shot(page, `${tag}-3-models-default-row`);
		const rows = await popup(page)
			.locator("[role=radio]")
			.evaluateAll((e) =>
				e.map(
					(x) =>
						`${x.getAttribute("aria-label")}:${x.getAttribute("aria-checked")}`,
				),
			);
		console.log(rows.join(" | "));
		assert.match(rows[0], /^Default, recommended: /);
		ok(`${tag} Default row first`);
		assert.ok(await popup(page).getByText(`Recommended · ${top}`).isVisible());
		// the checked row follows the saved choice (the top model, not yet a preset)
		assert.match(rows[0], /:false$/);
		await popup(page)
			.getByRole("radio", { name: /^Default/ })
			.click();
		await page.waitForTimeout(500);
		assert.equal((await levelsOf(page)) >= 2, true);
		ok(`${tag} choosing from the effort panel returns to it`);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
		await trig(page).click();
		await page.waitForTimeout(300);
		await popup(page)
			.getByRole("button", { name: /change model/ })
			.click();
		await page.waitForTimeout(400);
		assert.equal(
			await popup(page)
				.getByRole("radio", { name: /^Default/ })
				.getAttribute("aria-checked"),
			"true",
		);
		ok(`${tag} check sits on Default`);
		assert.equal(
			await popup(page)
				.getByRole("radio", {
					name: new RegExp(`^(Codex|Claude Code|Claude) ${top}$`),
				})
				.getAttribute("aria-checked"),
			"false",
		);
		await shot(page, `${tag}-4-default-checked`);
		// keyboard: the list opens with the checked row focused; arrows move the highlight only
		assert.equal(
			await page.evaluate(() => document.activeElement?.getAttribute("role")),
			"radio",
		);
		ok(`${tag} list focus starts on a row`);
		const before = await label(page);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await page.waitForTimeout(250);
		assert.equal(await label(page), before);
		ok(`${tag} arrows do not commit`);
		await shot(page, `${tag}-5-keyboard-highlight`);
		await popup(page)
			.getByRole("radio", {
				name: new RegExp(`^(Codex|Claude Code|Claude) ${second}$`),
			})
			.focus();
		await page.keyboard.press("Enter");
		await page.waitForTimeout(700);
		if (!((await levelsOf(page)) >= 2))
			console.log(
				"STATE",
				await label(page),
				await page.locator('[data-slot="popover-popup"]').count(),
				await page
					.locator(".model-picker-body")
					.evaluateAll((e) => e.map((x) => x.innerText.slice(0, 200))),
			);
		assert.equal((await levelsOf(page)) >= 2, true);
		assert.match(await label(page), new RegExp(`Model: ${second}`));
		ok(`${tag} Enter commits and returns to effort`, await label(page));
		// effort: raise it on the second model, keep it on a model that offers it, clear it on one that does not
		await page.keyboard.press("End");
		await page.waitForTimeout(400);
		assert.match(await label(page), /effort: Max$/);
		ok(`${tag} End reaches Max`);
		await shot(page, `${tag}-6-effort-top`);
		await popup(page)
			.getByRole("button", { name: /change model/ })
			.click();
		await page.waitForTimeout(500);
		await popup(page)
			.getByRole("radio", {
				name: new RegExp(`^(Codex|Claude Code|Claude) ${back}$`),
			})
			.click();
		await page.waitForTimeout(1200);
		assert.match(
			await label(page),
			new RegExp(`Model: ${back}, effort: Medium$`),
		);
		ok(
			`${tag} an effort the new model lacks falls back to its default`,
			await label(page),
		);
		const saved = await page.evaluate(() =>
			window.namzu.draftSettings("sample-thread-7"),
		);
		assert.equal(saved.options?.effort, undefined);
		ok(
			`${tag} stale effort cleared from saved settings`,
			JSON.stringify(saved),
		);
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(400);
		assert.match(await label(page), /effort: High$/);
		await popup(page)
			.getByRole("button", { name: /change model/ })
			.click();
		await page.waitForTimeout(500);
		await popup(page)
			.getByRole("radio", {
				name: new RegExp(`^(Codex|Claude Code|Claude) ${second}$`),
			})
			.click();
		await page.waitForTimeout(1200);
		assert.match(
			await label(page),
			new RegExp(`Model: ${second}, effort: High$`),
		);
		ok(`${tag} a saved effort the new model offers is kept`, await label(page));
		await popup(page)
			.getByRole("button", { name: /change model/ })
			.click();
		await page.waitForTimeout(500);
		await popup(page)
			.getByRole("radio", {
				name: new RegExp(`^(Codex|Claude Code|Claude) ${none}$`),
			})
			.click();
		await page.waitForTimeout(1200);
		assert.equal(await label(page), `Model: ${none}`);
		ok(
			`${tag} model without effort has no effort in the trigger`,
			await label(page),
		);
		assert.equal(
			await page.locator('[data-slot="popover-popup"]').count(),
			0,
			"panel closes for a model with no levels",
		);
		ok(`${tag} panel closes when the model offers no effort`);
		await trig(page).click();
		await page.waitForTimeout(400);
		assert.equal(
			await popup(page)
				.getByRole("heading", { name: "Choose a model" })
				.isVisible(),
			true,
		);
		assert.equal(
			await popup(page).getByRole("button", { name: "Effort" }).count(),
			0,
		);
		ok(`${tag} no-effort model opens the list directly`);
		await shot(page, `${tag}-7-list-direct`);
		await noClip(page, `${tag} list`);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
		assert.equal(
			await page.evaluate(() =>
				document.activeElement?.classList.contains("model-picker-trigger"),
			),
			true,
		);
		ok(`${tag} Escape from the list returns focus`);
		await page.close();
	}
	// ---- Light 640x720 and narrow container
	{
		const page = await open(browser, { engine: "codex-cli" });
		await page.setViewportSize({ width: 640, height: 720 });
		await page.waitForTimeout(500);
		await theme(page, "light");
		const visible = await page
			.locator(".model-picker-trigger-effort")
			.isVisible();
		console.log(
			"effort label visible at 640:",
			visible,
			"composer width",
			await page
				.locator(".normal-composer-shell")
				.first()
				.evaluate((e) => Math.round(e.getBoundingClientRect().width)),
		);
		await shot(page, "light-640-trigger");
		await trig(page).click();
		await page.waitForTimeout(400);
		await shot(page, "light-640-effort");
		const r = await noClip(page, "light effort");
		ok("light 640 effort geometry", JSON.stringify(r));
		await popup(page)
			.getByRole("button", { name: /change model/ })
			.click();
		await page.waitForTimeout(400);
		await shot(page, "light-640-models");
		await noClip(page, "light models");
		await page.keyboard.press("Escape");
		await page.close();
	}
	// ---- Pal 560
	{
		const page = await browser.newPage({
			viewport: { width: 1280, height: 900 },
			colorScheme: "dark",
		});
		page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
		await page.addInitScript(() => {
			let v;
			Object.defineProperty(window, "namzu", {
				configurable: true,
				get: () => v,
				set(api) {
					v = api;
					void api
						.createPal({
							name: "Kiro",
							model: { provider: "anthropic", model: "sample-balanced" },
						})
						.then(() => api.newConversation("project-sample-pal-1"));
				},
			});
		});
		await page.goto("http://127.0.0.1:5173/preview");
		await page.waitForTimeout(1800);
		await page.getByText("Kiro").first().click();
		await page.waitForTimeout(1200);
		await page.setViewportSize({ width: 560, height: 720 });
		await page.waitForTimeout(500);
		await page
			.getByRole("button", { name: "Attachments and message settings" })
			.click();
		await page.waitForTimeout(500);
		await page.screenshot({ path: `${S}/pal-560-plus.png` });
		const palTrigger = page.locator(
			".pal-composer-tools button.model-picker-trigger",
		);
		console.log("pal trigger", await palTrigger.getAttribute("aria-label"));
		await palTrigger.click();
		await page.waitForTimeout(500);
		await page.screenshot({ path: `${S}/pal-560-effort.png` });
		const pops = await page
			.locator('[data-slot="popover-popup"]')
			.evaluateAll((els) =>
				els.map((e) => {
					const b = e.getBoundingClientRect();
					return {
						l: Math.round(b.left),
						r: Math.round(b.right),
						t: Math.round(b.top),
						b: Math.round(b.bottom),
						label: e.getAttribute("aria-label"),
					};
				}),
			);
		console.log(JSON.stringify(pops));
		ok("pal nested popovers", JSON.stringify(pops));
		assert.ok(
			pops.every((p) => p.l >= 0 && p.r <= 560 && p.t >= 0 && p.b <= 720),
		);
		await page.close();
	}
} finally {
	await browser.close();
}
console.log(results.length, "checks passed");
