// Key screenshots and measured checks for the composer controls, against the design preview.
import { writeFileSync } from "node:fs";
import { S, chromium, open } from "./lib.mjs";

const out = [];
const log = (line) => {
	out.push(line);
	console.log(line);
};
const trig = (page) => page.locator("button.model-picker-trigger");
const popup = (page) => page.locator('[data-slot="popover-popup"]').last();
const perm = (page) => page.locator(".composer-permission-control");
async function theme(page, value) {
	await page.evaluate(
		(v) => document.documentElement.classList.toggle("dark", v === "dark"),
		value,
	);
	await page.waitForTimeout(150);
}
// The composer's lower region around the trigger and its popup.
async function shot(page, name, extra) {
	const boxes = [
		await page.locator(".normal-composer-shell").first().boundingBox(),
	];
	const p = await popup(page)
		.boundingBox()
		.catch(() => null);
	if (p && extra !== "none") boxes.push(p);
	const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 16);
	const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 16);
	const r = Math.max(...boxes.map((b) => b.x + b.width)) + 16;
	const b = Math.max(...boxes.map((b) => b.y + b.height)) + 16;
	const vp = page.viewportSize();
	await page.screenshot({
		path: `${S}/${name}.png`,
		clip: {
			x,
			y,
			width: Math.min(vp.width - x, r - x),
			height: Math.min(vp.height - y, b - y),
		},
	});
}
const popupBox = async (page) => {
	const b = await popup(page).boundingBox();
	return {
		w: Math.round(b.width),
		h: Math.round(b.height),
		top: Math.round(b.y),
	};
};
// Frame-by-frame samples of one measurement while an action runs.
async function sample(page, read, action, frames = 14) {
	await page.evaluate(
		({ read, frames }) => {
			window.__samples = [];
			const fn = new Function(`return (${read})()`);
			let n = 0;
			const tick = () => {
				window.__samples.push(fn());
				if (++n < frames) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		},
		{ read: read.toString(), frames },
	);
	await action();
	await page.waitForTimeout(500);
	return page.evaluate(() => window.__samples);
}

const browser = await chromium.launch();
try {
	for (const [engine, tag] of [
		["codex-cli", "codex"],
		["claude-code", "claude"],
		["namzu", "namzu"],
	]) {
		const page = await open(browser, { engine });
		await theme(page, "dark");
		await shot(page, `${tag}-dark-1-trigger`, "none");
		await trig(page).click();
		await page.waitForTimeout(500);
		await shot(page, `${tag}-dark-2-effort`);
		const effort = await popupBox(page);
		// slider motion: thumb position over frames after one key press
		const thumb = await sample(
			page,
			() =>
				Math.round(
					document
						.querySelector(".composer-effort-thumb")
						.getBoundingClientRect().x,
				),
			() => page.keyboard.press("ArrowRight"),
		);
		log(
			`${tag} slider thumb x per frame after ArrowRight: ${[...new Set(thumb)].join(" -> ")}`,
		);
		await popup(page)
			.getByRole("button", { name: /change model/ })
			.click();
		await page.waitForTimeout(600);
		await shot(page, `${tag}-dark-3-models`);
		const list = await popupBox(page);
		log(
			`${tag} popup width effort ${effort.w} list ${list.w} (${effort.w === list.w ? "same" : "DIFFERENT"}); list height ${list.h}`,
		);
		const clipped = await page.evaluate(() => {
			const l = document.querySelector(".model-picker-list");
			return { scroll: l.scrollHeight, client: l.clientHeight };
		});
		log(
			`${tag} model list scroll ${clipped.scroll} client ${clipped.client} (${clipped.scroll <= clipped.client + 1 ? "no scrolling" : "scrolls"})`,
		);
		// height easing: popup height over frames when going back to the effort panel
		const back = popup(page).getByRole("button", { name: "Effort" });
		if (await back.count()) {
			const heights = await sample(
				page,
				() =>
					Math.round(
						document
							.querySelector(".model-picker-resize")
							.getBoundingClientRect().height,
					),
				() => back.click(),
			);
			log(
				`${tag} height per frame, list to effort: ${[...new Set(heights)].join(" -> ")}`,
			);
		}
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
		await perm(page).click();
		await page.waitForTimeout(500);
		await shot(page, `${tag}-dark-4-permissions`);
		const rows = await page.locator("[role=menuitemradio]").allTextContents();
		log(
			`${tag} permission rows: ${rows.map((r) => r.replace(/\s+/g, " ")).join(" | ")}`,
		);
		await page.keyboard.press("Escape");
		if (engine === "codex-cli") {
			await perm(page).click();
			await page.getByRole("menuitemradio", { name: /Full access/ }).click();
			await page.waitForTimeout(400);
			const confirm = page.getByRole("button", { name: /Enable full access/ });
			if (await confirm.count()) await confirm.click();
			await page.waitForTimeout(400);
			await shot(page, `${tag}-dark-5-full-access-chip`, "none");
			const chip = await perm(page).evaluate((e) => ({
				label: e.getAttribute("aria-label"),
				color: getComputedStyle(e).color,
			}));
			log(`${tag} full access chip: ${chip.label} colour ${chip.color}`);
		}
		await page.close();
	}
	// light, narrow
	for (const [engine, tag] of [
		["codex-cli", "codex"],
		["namzu", "namzu"],
	]) {
		const page = await open(browser, { engine });
		await page.setViewportSize({ width: 640, height: 720 });
		await page.waitForTimeout(500);
		await theme(page, "light");
		await shot(page, `${tag}-light640-1-trigger`, "none");
		await trig(page).click();
		await page.waitForTimeout(500);
		await shot(page, `${tag}-light640-2-effort`);
		await popup(page)
			.getByRole("button", { name: /change model/ })
			.click();
		await page.waitForTimeout(600);
		await shot(page, `${tag}-light640-3-models`);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
		await perm(page).click();
		await page.waitForTimeout(500);
		await shot(page, `${tag}-light640-4-permissions`);
		await page.keyboard.press("Escape");
		if (engine === "codex-cli") {
			await perm(page).click();
			await page.getByRole("menuitemradio", { name: /Full access/ }).click();
			await page.waitForTimeout(400);
			const confirm = page.getByRole("button", { name: /Enable full access/ });
			if (await confirm.count()) await confirm.click();
			await page.waitForTimeout(400);
			await shot(page, `${tag}-light640-5-full-access-chip`, "none");
			log(
				`${tag} light full access chip colour ${await perm(page).evaluate((e) => getComputedStyle(e).color)}`,
			);
		}
		await page.close();
	}
} finally {
	await browser.close();
}
writeFileSync(`${S}/measurements.txt`, `${out.join("\n")}\n`);
