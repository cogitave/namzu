// Every composer popup stays inside the window, at the window widths and zoom levels a person has.
// Each popup is opened at each size and its box, and its outer positioner's box, are measured with
// getBoundingClientRect against the viewport, in both themes. Screenshots land in
// research/composer-popups-20261009/ and are looked at, not asserted.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/composer-popups.test.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/composer-popups-20261009");
const WIDTHS = [900, 1100, 1440];
const ZOOMS = [1, 1.25, 1.5];
const THEMES = ["dark", "light"];

/** A `codex` that serves the app-server protocol, so the popup has a second engine to list. */
const FAKE_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv[2] === "--version") { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
if (process.argv[2] !== "app-server") process.exit(2);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const efforts = ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort }));
const models = ["fake-sol", "fake-luna"].map((id, index) => ({ id, model: id, displayName: "Fake " + id.slice(5), isDefault: index === 0, supportedReasoningEfforts: efforts, defaultReasoningEffort: "medium" }));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const frame = JSON.parse(line);
	if (frame.id === undefined) return;
	if (frame.method === "initialize") send({ id: frame.id, result: { userAgent: "fake", codexHome: "/tmp" } });
	else if (frame.method === "account/read") send({ id: frame.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
	else if (frame.method === "model/list") send({ id: frame.id, result: { data: models, nextCursor: null } });
	else send({ id: frame.id, result: {} });
}).on("close", () => process.exit(0));
`;

/**
 * The picture is Electron's own capture of the window, not Playwright's: with a zoom factor,
 * page.screenshot crops the zoomed page to its unzoomed size, which would hide the right edge.
 */
async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	const png = await w.app.evaluate(async ({ BrowserWindow }) => {
		const [win] = BrowserWindow.getAllWindows();
		return (await win.webContents.capturePage()).toPNG().toString("base64");
	});
	writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(png, "base64"));
}

async function setAppearance(w, value) {
	await w.page.evaluate((next) => {
		localStorage.setItem("namzu.appearance", next);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: next }));
	}, value);
	await expect(w.page.locator("html")).toHaveClass(value === "dark" ? /dark/ : /^(?!.*dark)/);
}

async function resize(w, width, zoom) {
	await w.app.evaluate(
		({ BrowserWindow }, [wide, factor]) => {
			for (const win of BrowserWindow.getAllWindows()) {
				win.setSize(wide, 800);
				win.webContents.setZoomFactor(factor);
			}
		},
		[width, zoom],
	);
	// The page has taken the new size when its CSS viewport is the window over the zoom.
	await expect
		.poll(
			() =>
				w.page.evaluate(
					([wide, factor]) => Math.abs(window.innerWidth - Math.round(wide / factor)) <= 2,
					[width, zoom],
				),
			{ timeout: T },
		)
		.toBe(true);
}

/** Resolves once the open popup's box is identical for 20 frames in a row. */
function settled() {
	return new Promise((done) => {
		let last = "";
		let same = 0;
		const frame = () => {
			const popup = document.querySelector('[data-slot="popover-popup"]');
			const r = popup?.getBoundingClientRect();
			const now = r ? [r.left, r.top, r.right, r.bottom].map((n) => n.toFixed(2)).join() : "";
			same = now && now === last ? same + 1 : 0;
			last = now;
			if (same >= 20) done(true);
			else requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
	});
}

/** The open popup and its positioner, as boxes in CSS pixels, with the viewport they must fit. */
function measure() {
	const popups = [...document.querySelectorAll('[data-slot="popover-popup"]')];
	const box = (el) => {
		const r = el.getBoundingClientRect();
		return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
	};
	return {
		viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
		popups: popups.map((popup) => ({
			label: popup.getAttribute("aria-label") ?? popup.className,
			popup: box(popup),
			positioner: box(popup.closest('[data-slot="popover-positioner"]') ?? popup),
		})),
	};
}

function assertInside(m, label) {
	assert.ok(m.popups.length >= 1, `${label}: a popup is open`);
	const { viewport } = m;
	for (const open of m.popups)
		for (const part of ["popup", "positioner"]) {
			const b = open[part];
			assert.ok(
				b.left >= -0.5 && b.right <= viewport.width + 0.5,
				`${label}: the ${part} of "${open.label}" leaves the window sideways (${b.left.toFixed(1)}..${b.right.toFixed(1)} of ${viewport.width})`,
			);
			assert.ok(
				b.top >= -0.5 && b.bottom <= viewport.height + 0.5,
				`${label}: the ${part} of "${open.label}" leaves the window vertically (${b.top.toFixed(1)}..${b.bottom.toFixed(1)} of ${viewport.height})`,
			);
		}
}

/** How to open each popup from the composer, and how to know it is open. */
const POPUPS = [
	{
		name: "effort",
		trigger: (p) => p.getByRole("button", { name: /^Model[:,]|gpt-|Select model/ }).first(),
		open: (p) => p.getByRole("dialog", { name: "Reasoning effort" }),
	},
	{
		name: "model",
		trigger: (p) => p.getByRole("button", { name: /^Model[:,]|gpt-|Select model/ }).first(),
		before: (p) => p.getByRole("button", { name: /change model/ }).click(),
		open: (p) => p.getByRole("dialog", { name: "Model picker" }),
	},
	{
		name: "engine",
		trigger: (p) => p.getByRole("button", { name: /^Model[:,]|gpt-|Select model/ }).first(),
		before: (p) => p.getByRole("button", { name: /^Engine:/ }).click(),
		open: (p) => p.getByRole("dialog", { name: "Engine" }),
	},
	{
		name: "permission",
		trigger: (p) => p.getByRole("button", { name: /^Permissions:/ }),
		open: (p) => p.locator(".composer-permission-menu"),
	},
	{
		name: "attach",
		trigger: (p) => p.getByRole("button", { name: "Attachments and message settings" }),
		open: (p) => p.locator(".pal-composer-tools"),
	},
	{
		name: "project",
		trigger: (p) => p.getByRole("button", { name: "Choose project folder" }),
		open: (p) => p.locator(".composer-project-popup"),
	},
];

const PAL_POPUPS = [
	{
		name: "pal-attach",
		trigger: (p) => p.getByRole("button", { name: "Attachments and message settings" }),
		open: (p) => p.locator(".pal-composer-tools"),
	},
	{
		name: "pal-model",
		trigger: (p) => p.getByRole("button", { name: "Attachments and message settings" }),
		before: (p) =>
			p
				.locator(".pal-composer-tools")
				.getByRole("button", { name: /^Model[:,]|gpt-|Select model/ })
				.first()
				.click(),
		open: (p) => p.getByRole("dialog", { name: /Reasoning effort|Model picker/ }),
	},
];

async function sweep(w, popups, tag) {
	const seen = [];
	for (const theme of THEMES) {
		await setAppearance(w, theme);
		for (const width of WIDTHS) {
			for (const zoom of ZOOMS) {
				await resize(w, width, zoom);
				for (const popup of popups) {
					const label = `${tag} ${popup.name} ${theme} ${width}px x${zoom}`;
					// Re-open at each size so the popup is placed for it.
					// (a popup inside a popup takes one Escape each)
					await expect(async () => {
						await w.page.keyboard.press("Escape");
						await expect(w.page.locator('[data-slot="popover-popup"]')).toHaveCount(0, {
							timeout: 1000,
						});
					}).toPass({ timeout: T });
					await popup.trigger(w.page).click();
					await popup.before?.(w.page);
					await expect(popup.open(w.page)).toBeVisible({ timeout: T });
					// Placement is final once nothing animates...
					await expect
						// (the popup's own: a Pal's idle animation elsewhere on the page never ends)
						.poll(
							() =>
								w.page.evaluate(
									() =>
										document.getAnimations().filter((animation) => {
											const target = animation.effect?.target;
											return target?.closest?.('[data-slot="popover-positioner"]');
										}).length,
								),
							{ timeout: T },
						)
						.toBe(0);
					// ...and the popup's own content has arrived and its box has held still for a run of
					// frames (a catalogue loads after the popup opens and resizes it). Frames, not milliseconds.
					await expect(w.page.locator('[data-slot="popover-popup"]').last()).not.toContainText(
						/Loading|Checking/,
						{ timeout: T },
					);
					await w.page.evaluate(settled);
					const m = await w.page.evaluate(measure);
					// The picture is taken before the assertion, so a failing run still leaves it.
					if (zoom === 1.5 && width === 900)
						await shot(w, `${tag}-${popup.name}-${theme}-${width}-x${zoom}`);
					if (process.env.DEBUG_POPUPS) console.log(label, JSON.stringify(m));
					assertInside(m, label);
					seen.push(label);
				}
			}
		}
	}
	assert.equal(seen.length, THEMES.length * WIDTHS.length * ZOOMS.length * popups.length);
}

function flow(name, body) {
	test(name, { timeout: 900000 }, async () => {
		const bin = mkdtempSync(join(tmpdir(), "namzu-e2e-bin-"));
		writeFileSync(join(bin, "codex"), FAKE_CODEX);
		chmodSync(join(bin, "codex"), 0o755);
		const w = await createWorld({
			models: ["gpt-5.6-luna", "gpt-6-luna"],
			model: "gpt-5.6-luna",
			pathPrefix: bin,
			rules: [{ match: /hello/i, steps: [{ text: "Hello there." }] }],
		});
		let failed = true;
		try {
			await launch(w);
			await openProject(w);
			await body(w);
			assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(w, { failed });
			rmSync(bin, { recursive: true, force: true });
		}
	});
}

flow("every popup of the landing composer stays inside the window, at every width and zoom", (w) =>
	sweep(w, POPUPS, "home"),
);

flow("a popup left open while the window shrinks and zooms moves back inside it", async (w) => {
	for (const popup of POPUPS) {
		await resize(w, 1440, 1);
		await expect(async () => {
			await w.page.keyboard.press("Escape");
			await expect(w.page.locator('[data-slot="popover-popup"]')).toHaveCount(0, {
				timeout: 1000,
			});
		}).toPass({ timeout: T });
		await popup.trigger(w.page).click();
		await popup.before?.(w.page);
		await expect(popup.open(w.page)).toBeVisible({ timeout: T });
		await resize(w, 900, 1.5);
		await expect(w.page.locator('[data-slot="popover-popup"]').last()).not.toContainText(
			/Loading|Checking/,
			{ timeout: T },
		);
		await w.page.evaluate(settled);
		const m = await w.page.evaluate(measure);
		await shot(w, `shrunk-${popup.name}-900-x1.5`);
		assertInside(m, `shrunk ${popup.name}`);
	}
});

flow("every popup of a conversation's composer stays inside the window", async (w) => {
	await send(w, "hello");
	await expect(w.page.getByText("Hello there.")).toBeVisible({ timeout: T });
	await sweep(
		w,
		POPUPS.filter((popup) => popup.name !== "project"),
		"conversation",
	);
});

flow("every popup of a Pal's composer stays inside the window", async (w) => {
	await expect(async () => {
		await w.page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		await expect(w.page.getByRole("region", { name: "Meet your Pal" })).toBeVisible({
			timeout: 2000,
		});
	}).toPass({ timeout: T });
	await expect(async () => {
		if (!(await w.page.getByRole("dialog", { name: "Customize your Pal" }).isVisible()))
			await w.page.getByRole("button", { name: "Customize your Pal" }).click({ timeout: 2000 });
		await expect(w.page.getByRole("dialog", { name: "Customize your Pal" })).toBeVisible({
			timeout: 2000,
		});
	}).toPass({ timeout: T });
	const name = w.page.getByRole("textbox", { name: "Pal name" });
	await name.fill("Işık");
	await name.press("Enter");
	await expect(w.page.getByRole("tab", { name: "Işık" })).toBeVisible({ timeout: T });
	await expect(w.page.getByText("Ready to chat")).toBeVisible({ timeout: T });
	await sweep(w, PAL_POPUPS, "pal");
});
