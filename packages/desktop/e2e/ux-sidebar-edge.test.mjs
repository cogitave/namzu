// The sidebar is open attached to the left edge (or, in a window too narrow for it beside the content,
// an overlay that starts at the rail's right edge), never offset into the main area; closed it is gone;
// the toggle always matches what is drawn; the state survives a resize. Measured at several widths.
// Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-sidebar-edge.test.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	createWorld,
	dispose,
	expect,
	launch,
	openProject,
} from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(process.env.SHOTS ?? join(tmpdir(), "ux-sidebar-edge"));
const RAIL = 48;
const WIDTHS = [1280, 1000, 900, 760, 600];

async function size(w, width, height = 820) {
	await w.app.evaluate(
		({ BrowserWindow }, [wide, high]) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(wide, high);
		},
		[width, height],
	);
	await expect
		.poll(
			() => w.page.evaluate((x) => Math.abs(window.innerWidth - x), width),
			{ timeout: T },
		)
		.toBeLessThanOrEqual(2);
}
const settled = (w) =>
	w.page.evaluate(() =>
		Promise.all(
			document
				.getAnimations()
				.filter(
					(a) =>
						a.effect?.getComputedTiming().iterations !==
						Number.POSITIVE_INFINITY,
				)
				.map((a) => a.finished.catch(() => {})),
		),
	);
/** What is drawn: the sidebar's visible box, the rail's, the content's left edge. */
const read = (w) =>
	w.page.evaluate(() => {
		const box = (s) => {
			const el = document.querySelector(s);
			if (!el) return null;
			const b = el.getBoundingClientRect();
			const shown =
				getComputedStyle(el).visibility !== "hidden" &&
				b.width > 0 &&
				getComputedStyle(el).opacity !== "0";
			return {
				x: Math.round(b.left * 10) / 10,
				right: Math.round(b.right * 10) / 10,
				w: Math.round(b.width * 10) / 10,
				y: b.top,
				shown,
			};
		};
		return {
			sidebar: box("[data-app-sidebar]"),
			rail: box(".navigation-rail"),
			content: box(".workspace"),
			collapsed: document
				.querySelector(".app")
				?.getAttribute("data-sidebar-collapsed"),
			open: document
				.querySelector("[data-app-sidebar]")
				?.classList.contains("open"),
			scrim:
				!!document.querySelector(".scrim") &&
				getComputedStyle(document.querySelector(".scrim")).display !== "none",
			narrow: window.matchMedia("(max-width: 767px)").matches,
		};
	});
const shot = async (w, name) => {
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
};
const toggle = (w) => w.page.getByRole("button", { name: "Toggle sidebar" });

/** Asserts the sidebar is where the state says. */
function check(label, s, wantOpen) {
	if (!wantOpen) {
		assert.equal(
			s.sidebar?.shown ?? false,
			false,
			`${label}: the sidebar is not drawn`,
		);
		return;
	}
	assert.equal(s.sidebar.shown, true, `${label}: the sidebar is drawn`);
	const edge = s.narrow ? RAIL : s.rail?.shown ? s.rail.right : 0;
	assert.equal(
		s.sidebar.x,
		edge,
		`${label}: the sidebar starts at ${edge} (${s.narrow ? "the rail's edge" : "the window's edge"})`,
	);
	assert.ok(
		s.sidebar.w > 0 && s.sidebar.w <= 288,
		`${label}: the sidebar is at most 288 wide`,
	);
	if (!s.narrow)
		assert.equal(
			s.content.x,
			s.sidebar.right,
			`${label}: the content starts where the sidebar ends`,
		);
	assert.equal(
		s.scrim,
		s.narrow,
		`${label}: the scrim shows only over the narrow overlay`,
	);
}

for (const width of WIDTHS) {
	test(
		`sidebar edge at ${width}: open, closed, hover, and the rail`,
		{ timeout: 280000 },
		async () => {
			const w = await createWorld({ rules: [], tabs: "hidden" });
			let failed = true;
			try {
				await launch(w);
				await openProject(w);
				await size(w, width);
				await settled(w);
				const narrow = width < 768;
				// Wide: open by default. Narrow: closed by default.
				let s = await read(w);
				if (narrow) check(`${width} start`, s, false);
				else check(`${width} start`, s, true);
				await shot(w, `${width}-start`);

				// Collapse (wide) / open (narrow), then the other way, twice.
				for (let round = 0; round < 2; round++) {
					await toggle(w).click();
					await settled(w);
					s = await read(w);
					check(`${width} round ${round} after first click`, s, narrow);
					await shot(w, `${width}-after-toggle-${round}-a`);
					// Hover the rail and leave it.
					await w.page.mouse.move(10, 400);
					await settled(w);
					await w.page.mouse.move(width - 20, 400);
					await settled(w);
					s = await read(w);
					check(`${width} round ${round} after hover`, s, narrow);
					await toggle(w).click();
					await settled(w);
					s = await read(w);
					check(`${width} round ${round} after second click`, s, !narrow);
					await shot(w, `${width}-after-toggle-${round}-b`);
				}
				failed = false;
			} finally {
				await dispose(w, { failed });
			}
		},
	);
}

test(
	"sidebar edge: the state survives a resize across the narrow breakpoint, open and closed",
	{ timeout: 280000 },
	async () => {
		const w = await createWorld({ rules: [], tabs: "hidden" });
		let failed = true;
		try {
			await launch(w);
			await openProject(w);
			for (const [from, to] of [
				[1280, 600],
				[600, 1280],
			]) {
				await size(w, from);
				await settled(w);
				await size(w, to);
				await settled(w);
				const s = await read(w);
				await shot(w, `resize-${from}-to-${to}`);
				if (to >= 768)
					check(`resized ${from} to ${to}`, s, s.collapsed !== "true");
				else check(`resized ${from} to ${to}`, s, s.open === true);
			}
			// Open at 1280, narrow it, and widen again: still open.
			await size(w, 1280);
			await settled(w);
			let s = await read(w);
			const wasOpen = s.collapsed !== "true";
			await size(w, 600);
			await settled(w);
			await size(w, 1280);
			await settled(w);
			s = await read(w);
			assert.equal(
				s.collapsed !== "true",
				wasOpen,
				"the wide state is kept across a narrow visit",
			);
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	},
);

const expanded = (w) => toggle(w).getAttribute("aria-expanded");

test(
	"sidebar edge: in the narrow overlay Esc, a click outside and a double toggle close it, Settings leaves it closed, widening keeps it docked",
	{ timeout: 280000 },
	async () => {
		const w = await createWorld({ rules: [], tabs: "hidden" });
		let failed = true;
		try {
			await launch(w);
			await openProject(w);
			await size(w, 600);
			await settled(w);
			const open = async (label) => {
				await toggle(w).click();
				await settled(w);
				const s = await read(w);
				check(`${label}: opened`, s, true);
				assert.equal(await expanded(w), "true", `${label}: toggle says open`);
			};
			const closed = async (label) => {
				await settled(w);
				const s = await read(w);
				check(`${label}: closed`, s, false);
				assert.equal(
					await expanded(w),
					"false",
					`${label}: toggle says closed`,
				);
			};
			await open("esc");
			await w.page.keyboard.press("Escape");
			await closed("esc");

			await open("outside");
			await w.page.mouse.click(540, 400);
			await closed("outside");

			await toggle(w).dblclick();
			await closed("double toggle");

			// Open the overlay, then widen: it stays docked at the edge.
			await open("before widen");
			await size(w, 1280);
			await settled(w);
			const s = await read(w);
			check("widened from an open overlay", s, true);
			await size(w, 600);
			await settled(w);
			if ((await read(w)).sidebar?.shown) await toggle(w).click();

			await open("settings");
			await w.page
				.getByRole("button", { name: /settings/i })
				.first()
				.click();
			await closed("settings");
			await shot(w, "600-settings");
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	},
);
