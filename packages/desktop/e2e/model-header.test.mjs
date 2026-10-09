// The header of the model popup against the real Electron app: the back link, the title, the engine
// chip, the Desktop | CLI switch and the search button must never overlap, at the window widths and
// zoom levels a person has. Measured with getBoundingClientRect, in both themes, on the Namzu engine
// (whose chip is the wordmark) and on Codex.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/model-header.test.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/model-header-20261009");
const WIDTHS = [900, 1100, 1280, 1440];
const ZOOMS = [1, 1.25, 1.5];
const THEMES = ["dark", "light"];

/** A `codex` that serves the app-server protocol with three reasoning levels per model. */
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

function flow(name, options, body) {
	test(name, { timeout: 600000 }, async () => {
		const pathPrefix = mkdtempSync(join(tmpdir(), "namzu-e2e-bin-"));
		writeFileSync(join(pathPrefix, "codex"), FAKE_CODEX);
		chmodSync(join(pathPrefix, "codex"), 0o755);
		const world = await createWorld({ ...options, pathPrefix });
		let failed = true;
		try {
			await launch(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
			rmSync(pathPrefix, { recursive: true, force: true });
		}
	});
}

async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
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
	await expect
		.poll(() => w.page.evaluate(() => Math.round(window.outerWidth)), { timeout: T })
		.toBeGreaterThan(0);
}

/** Boxes of the header's parts, in CSS pixels. */
function measure() {
	const header = document.querySelector(".model-picker-heading");
	if (!header) return null;
	const box = (el) => {
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
	};
	const title = header.querySelector(".model-picker-title");
	return {
		header: box(header),
		parts: {
			back: box(header.querySelector(".model-picker-back")),
			title: box(title),
			chip: box(header.querySelector(".engine-chip")),
			mark: box(header.querySelector(".engine-chip .namzu-wordmark, .engine-chip svg")),
			switch: box(header.querySelector(".surface-switch")),
			search: box(header.querySelector('button[aria-label="Search models"]')),
		},
		titleText: title?.textContent ?? "",
		titleClipped: title ? title.scrollWidth > title.clientWidth : false,
		rows: header.getBoundingClientRect().height,
	};
}

/** No two of the header's parts share any pixels, and none leaves the header. */
function assertNoOverlap(m, label) {
	const names = Object.keys(m.parts).filter((k) => m.parts[k] && k !== "mark");
	for (let i = 0; i < names.length; i++) {
		for (let j = i + 1; j < names.length; j++) {
			const a = m.parts[names[i]];
			const b = m.parts[names[j]];
			const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
			const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
			assert.ok(
				across <= 0.5 || down <= 0.5,
				`${label}: ${names[i]} overlaps ${names[j]} (${across.toFixed(1)}px across, ${down.toFixed(1)}px down)`,
			);
		}
	}
	const { header } = m;
	for (const name of Object.keys(m.parts)) {
		const p = m.parts[name];
		if (!p) continue;
		assert.ok(
			p.left >= header.left - 0.5 && p.right <= header.right + 0.5,
			`${label}: ${name} leaves the header (${p.left}..${p.right} vs ${header.left}..${header.right})`,
		);
	}
	// The mark is lettering, so its drawn box counts: it stays inside the chip.
	if (m.parts.mark && m.parts.chip) {
		assert.ok(
			m.parts.mark.left >= m.parts.chip.left - 0.5 && m.parts.mark.right <= m.parts.chip.right + 0.5,
			`${label}: the mark spills out of the chip`,
		);
	}
}

async function openModels(w) {
	await w.page.getByRole("button", { name: /^Model[:,]|gpt-|Fake|GPT/ }).first().click();
	const change = w.page.getByRole("button", { name: /change model/ });
	await expect(change.or(w.page.locator(".model-picker-heading"))).toBeVisible({ timeout: T });
	if (await change.count()) await change.click();
	await expect(w.page.locator(".model-picker-heading .model-picker-title")).toBeVisible({
		timeout: T,
	});
}

async function sweep(w, tag) {
	const seen = [];
	for (const theme of THEMES) {
		await setAppearance(w, theme);
		for (const width of WIDTHS) {
			for (const zoom of ZOOMS) {
				await resize(w, width, zoom);
				const label = `${tag} ${theme} ${width}px x${zoom}`;
				// Re-open at each size so the popup is placed for it.
				await w.page.keyboard.press("Escape");
				await openModels(w);
				// The popup's own height animation has finished when nothing animates.
				await expect
					.poll(() => w.page.evaluate(() => document.getAnimations().length), { timeout: T })
					.toBe(0);
				const m = await w.page.evaluate(measure);
				assert.ok(m, `${label}: no header`);
				// The picture is taken before the assertion, so a failing run still leaves it.
				if (zoom === 1 || (zoom === 1.5 && width === 900))
					await shot(w, `${process.env.SHOT_PREFIX ?? ""}${tag}-${theme}-${width}-x${zoom}`);
				assertNoOverlap(m, label);
				seen.push({ label, m });
			}
		}
	}
	// The chip, the switch and the search button never shrink below their size in the roomiest window
	// (a narrow window may enlarge a hit area, which is not a squeeze).
	for (const key of ["chip", "switch", "search"]) {
		const own = seen.filter((s) => s.m.parts[key]);
		const roomy = own.find((s) => s.label.endsWith("1440px x1"))?.m.parts[key].width;
		for (const s of own)
			assert.ok(s.m.parts[key].width >= roomy - 1, `${s.label}: the ${key} was squeezed to ${s.m.parts[key].width}px from ${roomy}px`);
	}
	assert.ok(
		seen.some((s) => s.m.parts.chip),
		`${tag}: the chip was measured`,
	);
	return seen;
}

flow(
	"the model popup header never overlaps on the Namzu engine, with the wordmark chip",
	{ models: ["gpt-5.6-luna", "gpt-6-luna"], model: "gpt-5.6-luna" },
	async (w) => {
		await openProject(w);
		await sweep(w, "namzu");
	},
);

flow("the model popup header never overlaps on Codex", {}, async (w) => {
	await openProject(w);
	await w.page.getByRole("button", { name: /gpt-e2e-1|gpt-e2e-0/ }).first().click();
	await w.page.getByRole("button", { name: /^Engine:/ }).click();
	await w.page.getByRole("radio", { name: /Codex CLI/ }).click();
	await expect(w.page.getByRole("button", { name: /Fake sol/i }).first()).toBeVisible({
		timeout: T,
	});
	await sweep(w, "codex");
});
