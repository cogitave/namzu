// The home screen and an open conversation never move without input: the heading, the starters and the
// box are sampled on every painted frame while the window is resized a pixel at a time across each
// threshold, the draft grows, a file is attached and the page is zoomed. A value that changes
// back and forth with no input in between is a layout loop and fails the run.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-home-layout-stable.test.mjs
// Pictures go to $SHOTS (default: the temp folder).
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, desktopRoot, dispose, expect, launch, openProject } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(process.env.SHOTS ?? join(tmpdir(), "home-layout-stable"));
const FRAMES = 12;
const SETTLE = 3;

const box = (w) => w.page.getByRole("textbox", { name: "Message Namzu" });

/** Start the sampler in the page; it records every frame's positions until stopped. */
async function startSampler(w) {
	await w.page.evaluate(() => {
		const rect = (selector) => {
			const el = document.querySelector(selector);
			if (!el || el.getClientRects().length === 0) return null;
			const b = el.getBoundingClientRect();
			return [Math.round(b.top * 100) / 100, Math.round(b.height * 100) / 100];
		};
		const frames = [];
		const sampler = { frames, live: true };
		window.__sampler = sampler;
		const tick = () => {
			if (!sampler.live) return;
			const heading = document.querySelector("[data-composer-heading]");
			frames.push({
				heading: heading && getComputedStyle(heading).visibility === "hidden" ? null : rect("[data-composer-heading]"),
				starters: (() => {
					const el = document.querySelector(".starter-actions");
					return el && getComputedStyle(el).display === "none" ? null : rect(".starter-actions");
				})(),
				dock: rect("[data-composer-dock]"),
				size: [window.innerWidth, window.innerHeight],
				stage: rect(".chat-stage"),
				bars: (() => {
					const c = document.querySelector(".workspace-canvas");
					return c ? [c.offsetWidth - c.clientWidth, c.offsetHeight - c.clientHeight] : null;
				})(),
			});
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
}
async function stopSampler(w) {
	return w.page.evaluate(() => {
		window.__sampler.live = false;
		return window.__sampler.frames;
	});
}
/** Wait for n painted frames. */
const frames = (w, n) =>
	w.page.evaluate(
		(count) =>
			new Promise((done) => {
				let left = count;
				const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick));
				requestAnimationFrame(tick);
			}),
		n,
	);

/** A part flips when it returns to an earlier value after leaving it (A, B, A) with no input between. */
function oscillations(all, label) {
	const found = [];
	// A resize that crosses a breakpoint (the sidebar turning into a drawer) takes a frame or two to
	// reach every part, so the first frames after one are not judged: what must hold is that the
	// screen then stands still, and that is what the rest of the frames and the tail check say.
	const list = all.slice(SETTLE);
	for (const part of ["heading", "starters", "dock", "stage", "bars"]) {
		const keys = list.map((f) => JSON.stringify(f[part]));
		for (let i = 2; i < keys.length; i++)
			if (keys[i] === keys[i - 2] && keys[i] !== keys[i - 1])
				found.push(`${label}: ${part} went ${keys[i - 2]} -> ${keys[i - 1]} -> ${keys[i]} (frame ${i})`);
	}
	// Still moving at the end of a settled wait is a loop too.
	const tail = list.slice(-3).map((f) => JSON.stringify([f.heading, f.starters, f.dock, f.stage, f.bars]));
	if (new Set(tail).size > 1) found.push(`${label}: still changing after ${list.length} frames`);
	return found;
}

async function setWindow(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, size) => {
			for (const win of BrowserWindow.getAllWindows()) win.setContentSize(size.width, size.height);
		},
		{ width, height },
	);
	const f = w.zoomFactor ?? 1;
	await expect
		.poll(
			async () => {
				const [x, y] = await w.page.evaluate(() => [window.innerWidth, window.innerHeight]);
				return Math.max(Math.abs(x - width / f), Math.abs(y - height / f));
			},
			{ timeout: T },
		)
		.toBeLessThanOrEqual(1);
}
async function zoom(w, factor) {
	await w.app.evaluate(({ BrowserWindow }, f) => {
		for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomFactor(f);
	}, factor);
	w.zoomFactor = factor;

}


/** A scene is a state of the screen; every one is swept across the thresholds. */
const SCENES = {
	home: async () => {},
	draft: async (w) => {
		await box(w).fill("one\ntwo\nthree\nfour\nfive\nsix");
	},
	split: async (w) => {
		await w.page.getByRole("button", { name: "New conversation tab" }).click({ button: "right" });
		const menu = w.page.getByRole("menu", { name: "New tab" });
		await expect(menu).toBeVisible();
		await menu.getByRole("menuitem", { name: "New terminal to the right" }).click();
		await expect(w.page.locator(".workspace-canvas-pane")).toHaveCount(2, { timeout: T });
	},
	attached: async (w) => {
		await w.app.evaluate((_e, path) => {
			globalThis.__e2eDialog.open = [path];
		}, join(w.project, "notes.txt"));
		await w.page.getByRole("button", { name: /Attachments and message settings/ }).click();
		await w.page.getByRole("button", { name: "Attach files" }).click();
		await expect(w.page.getByText("notes.txt")).toBeVisible({ timeout: T });
	},
};

test("the home screen holds still while the window, the draft and the zoom change", { timeout: 3000000 }, async () => {
	const keep = process.env.BEFORE_APP ? join(tmpdir(), `home-before-${process.pid}`) : undefined;
	if (keep) {
		const app = join(keep, "app");
		mkdirSync(app, { recursive: true });
		cpSync(join(process.env.BEFORE_APP, "dist"), join(app, "dist"), { recursive: true });
		copyFileSync(join(process.env.BEFORE_APP, "package.json"), join(app, "package.json"));
		symlinkSync(join(desktopRoot, "node_modules"), join(app, "node_modules"), "dir");
	}
	const only = process.env.SCENES ? process.env.SCENES.split(",") : Object.keys(SCENES);
	const world = await createWorld({ keepRoot: keep, env: { SHELL: "/bin/sh" }, files: { "notes.txt": "hello" } });
	let failed = true;
	const problems = [];
	try {
		await launch(world);
		await openProject(world);
		await expect(box(world)).toBeVisible({ timeout: T });
		mkdirSync(SHOTS, { recursive: true });
		const probe = async (label, act) => {
			await startSampler(world);
			await act?.();
			await frames(world, FRAMES);
			const list = await stopSampler(world);
			const found = oscillations(list, label);
			if (found.length && problems.length < 3) console.log(JSON.stringify(list));
			problems.push(...found);
		};
		const HMAX = Number(process.env.HMAX ?? 560);
		const HMIN = Number(process.env.HMIN ?? 460);
		const WIDTHS = (process.env.WIDTHS ?? "1280,700").split(",").map(Number);
		const ZOOMS = (process.env.ZOOMS ?? "1,1.5").split(",").map(Number);
		for (const name of only) {
			await setWindow(world, 1280, 620);
			await SCENES[name](world);
			for (const factor of ZOOMS) {
				await zoom(world, factor);
				for (const width of WIDTHS) {
					await setWindow(world, width, HMAX);
					for (let height = HMAX; height >= HMIN; height -= 1) await probe(`${name} z${factor} ${width}x${height}`, () => setWindow(world, width, height));
					if (process.env.UP) for (let height = HMIN; height <= HMAX; height += 1) await probe(`${name} z${factor} ${width}x${height} up`, () => setWindow(world, width, height));
				}
				await zoom(world, 1);
			}
			await box(world).fill("");
		}
		console.log("problems:", problems.length);
		for (const line of problems.slice(0, 40)) console.log(line);
		assert.deepEqual(world.faults, [], "no uncaught error in the page");
		assert.deepEqual(problems, []);
		failed = false;
	} finally {
		await dispose(world, { failed });
	}
});
