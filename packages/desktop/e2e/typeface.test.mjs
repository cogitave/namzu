// The shipped typefaces in the real Electron app, built: the faces load from the app's own files
// under the unchanged content security policy, a reply paragraph, a code block and a sidebar row are
// drawn in them (the DevTools protocol says which font was really used for a node), the settings
// "Interface font" switches to the platform's fonts without a restart, ligatures stay off and the
// figures the app marks as tabular have equal widths. The display face (pixel letters, for the project's
// name in the home heading) is loaded, used there and nowhere else, off with the setting, and a name it
// cannot draw whole stays in the interface face.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/typeface.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { createWorld, dispose, expect, launch, openProject, send } from "./harness.mjs";

const T = 60000;

const REPLY = `Oturum süresi düzeltildi: ğ ş ı İ ç ö ü. The cause was a unit mix-up in \`createSession\`, with **bold** and *italic* words.

\`\`\`ts
const SESSION_TTL_MS = 60 * 60 * 24 * 7 * 1000;
export const same = a => b => a >= b && a !== b; // => <= >= !== ===
\`\`\`

Done, 0123456789.`;

const rules = [
	{ match: /rich reply/i, steps: [{ text: REPLY }] },
];

function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		const world = await createWorld(options);
		let failed = true;
		try {
			await launch(world);
			world.console = [];
			world.page.on("console", (m) => world.console.push(`${m.type()}: ${m.text()}`));
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	});
}

/** The platform fonts the engine really used for the first node of a selector. */
async function usedFonts(w, selector) {
	const cdp = await w.page.context().newCDPSession(w.page);
	try {
		await cdp.send("DOM.enable");
		await cdp.send("CSS.enable");
		const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
		const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
		assert.ok(nodeId, `${selector} is on the page`);
		const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
		return fonts.map((f) => ({ family: f.familyName, custom: f.isCustomFont }));
	} finally {
		await cdp.detach();
	}
}

const SELECTORS = {
	paragraph: ".chat-markdown p:last-of-type",
	code: ".chat-markdown pre code",
	inlineCode: ".chat-markdown p code",
	sidebarRow: "li[data-thread-item] .conversation-row-title",
};

async function replyOnScreen(w) {
	await openProject(w);
	await w.page.getByRole("button", { name: "New conversation" }).first().click();
	await send(w, "Give me a rich reply");
	await expect(w.page.getByText(/Done, 0123456789/)).toBeVisible({ timeout: T });
	await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
}

async function openAppearance(w) {
	await w.page.getByRole("button", { name: "Settings", exact: true }).click();
	const sections = w.page.getByRole("navigation", { name: "Settings sections" });
	await expect(sections).toBeVisible({ timeout: T });
	await sections.getByRole("button", { name: "Appearance", exact: true }).click();
	await expect(w.page.getByRole("heading", { level: 1, name: "Appearance", exact: true })).toBeVisible({
		timeout: T,
	});
}

flow(
	"the built app draws a reply, code and a sidebar row in the shipped faces, and the setting switches them",
	{ rules, tabs: "hidden" },
	async (w) => {
		await replyOnScreen(w);

		// The three files loaded from the app's own folder under the unchanged policy.
		const faces = await w.page.evaluate(async () => {
			await document.fonts.ready;
			return [...document.fonts].map((f) => `${f.family} ${f.style} ${f.weight} ${f.status}`);
		});
		assert.deepEqual(faces.sort(), [
			"Geist italic 100 900 loaded",
			"Geist normal 100 900 loaded",
			"Geist Mono normal 100 900 loaded",
			"Geist Pixel normal 400 loaded",
		].sort());
		const policy = await w.page.evaluate(
			() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
		);
		assert.match(policy, /default-src 'self'/);
		assert.doesNotMatch(policy, /font-src/);
		const refused = w.console.filter((line) => /Content Security Policy|Refused to load|Failed to load resource/i.test(line));
		assert.deepEqual(refused, [], "no font file was refused or missing");

		// Really used: each node reports one family and it is the shipped, custom one.
		for (const [label, family] of [
			["paragraph", "Geist"],
			["code", "Geist Mono"],
			["inlineCode", "Geist Mono"],
			["sidebarRow", "Geist"],
		]) {
			const used = await usedFonts(w, SELECTORS[label]);
			assert.ok(used.length > 0, `${label} drew some text`);
			for (const font of used) {
				assert.equal(font.family, family, `${label} is drawn in ${family}`);
				assert.equal(font.custom, true, `${label} uses the shipped file`);
			}
		}

		// Italic comes from the italic file, not a slanted upright.
		const italic = await w.page.evaluate(() => {
			const em = document.querySelector(".chat-markdown em");
			return em ? getComputedStyle(em).fontStyle : "none";
		});
		assert.equal(italic, "italic");
		const italicUsed = await usedFonts(w, ".chat-markdown em");
		assert.ok(italicUsed.length > 0);
		for (const font of italicUsed) {
			assert.match(font.family, /^Geist/);
			assert.equal(font.custom, true);
		}

		// The weight tokens are exact: the variable file serves 400, 500 and 600.
		const weights = await w.page.evaluate(() => {
			const root = getComputedStyle(document.documentElement);
			return ["--weight-text", "--weight-control", "--weight-strong"].map((n) => root.getPropertyValue(n).trim());
		});
		assert.deepEqual(weights, ["400", "500", "600"]);

		// Ligatures stay off: nothing turns a feature on in code, and the mono's ligature set is not asked for.
		const features = await w.page.evaluate(() => {
			const out = {};
			for (const [label, selector] of [["block", ".chat-markdown pre code"], ["inline", ".chat-markdown p code"], ["paragraph", ".chat-markdown p"]]) {
				const style = getComputedStyle(document.querySelector(selector));
				out[label] = {
					settings: style.fontFeatureSettings,
					ligatures: style.fontVariantLigatures,
					variationSettings: style.fontVariationSettings,
				};
			}
			return out;
		});
		for (const [label, f] of Object.entries(features)) {
			assert.equal(f.settings, "normal", `${label}: no feature switched on`);
			assert.doesNotMatch(f.settings, /ss11|liga|calt/);
			assert.equal(f.ligatures, "normal", `${label}: ligatures are the face's own default`);
		}

		// Tabular figures: every place the app marks as tabular draws equal-width digits, while the
		// same digits in plain text differ (so the check can tell).
		const widths = await w.page.evaluate(() => {
			const measure = (host) => {
				const probe = (text) => {
					const span = document.createElement("span");
					span.textContent = text;
					span.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
					host.appendChild(span);
					const width = span.getBoundingClientRect().width;
					span.remove();
					return width;
				};
				return { one: probe("1111"), zero: probe("0000"), mixed: probe("1807"), numeric: getComputedStyle(host).fontVariantNumeric };
			};
			const tabular = [...document.querySelectorAll("body *")].filter(
				(el) => getComputedStyle(el).fontVariantNumeric.includes("tabular-nums") && el.getBoundingClientRect().width > 0,
			);
			const seen = new Set();
			const hosts = [];
			for (const el of tabular) {
				const key = `${el.tagName}.${el.className}`;
				if (!seen.has(key)) {
					seen.add(key);
					hosts.push(el);
				}
			}
			return {
				plain: measure(document.querySelector(".chat-markdown p")),
				tabular: hosts.slice(0, 12).map(measure),
				count: hosts.length,
			};
		});
		assert.ok(widths.count > 0, "the screen has a place marked tabular");
		assert.notEqual(widths.plain.one, widths.plain.zero, "plain figures are proportional");
		for (const m of widths.tabular) {
			assert.equal(m.one, m.zero, "1111 and 0000 are equally wide");
			assert.equal(m.one, m.mixed, "1111 and 1807 are equally wide");
			assert.match(m.numeric, /tabular-nums/);
		}

		// The setting: Appearance has "Interface font", and the system's fonts apply at once.
		await openAppearance(w);
		const group = w.page.getByRole("group", { name: "Interface font" });
		await expect(group).toBeVisible({ timeout: T });
		await expect(group.getByRole("radio", { name: /Namzu’s own/ })).toBeChecked();
		await group.getByRole("radio", { name: /Your device’s/ }).check();
		await expect(w.page.locator("html")).toHaveAttribute("data-interface-font", "system");
		const stacks = await w.page.evaluate(() => {
			const root = getComputedStyle(document.documentElement);
			return { sans: root.getPropertyValue("--font-sans").trim(), mono: root.getPropertyValue("--font-mono").trim(), terminal: root.getPropertyValue("--font-terminal").trim(), body: getComputedStyle(document.body).fontFamily };
		});
		assert.doesNotMatch(stacks.sans, /Geist/);
		assert.doesNotMatch(stacks.mono, /Geist/);
		assert.match(stacks.terminal, /^"Geist Mono"/);
		assert.doesNotMatch(stacks.body, /Geist/);
		assert.equal(await w.page.evaluate(() => localStorage.getItem("namzu.interface-font")), "system");

		// Back to the conversation: the same nodes are now drawn in the platform's fonts.
		await w.page.getByRole("button", { name: "Home", exact: true }).click();
		await w.page.locator("li[data-thread-item]").first().click();
		await expect(w.page.locator(SELECTORS.paragraph).first()).toBeVisible({ timeout: T });
		for (const label of ["paragraph", "code", "sidebarRow"]) {
			const used = await usedFonts(w, SELECTORS[label]);
			for (const font of used) {
				assert.equal(font.custom, false, `${label} no longer uses a shipped file`);
				assert.doesNotMatch(font.family, /Geist/);
			}
		}

		// A reload keeps the choice, and the first paint has it (the boot script reads it).
		await w.page.reload();
		await w.page.waitForLoadState("domcontentloaded");
		assert.equal(await w.page.evaluate(() => document.documentElement.getAttribute("data-interface-font")), "system");

		// And back to the app's own, again without a restart.
		await openAppearance(w);
		await w.page.getByRole("group", { name: "Interface font" }).getByRole("radio", { name: /Namzu’s own/ }).check();
		await expect(w.page.locator("html")).not.toHaveAttribute("data-interface-font", /.+/);
		assert.equal(
			await w.page.evaluate(() => getComputedStyle(document.body).fontFamily.startsWith('Geist')),
			true,
		);
	},
);

flow("a terminal opens in the shipped mono, and the interface font setting leaves it alone", { env: { SHELL: "/bin/sh" } }, async (w) => {
	await openProject(w);
	await w.page.evaluate(() => localStorage.setItem("namzu.terminal.debug", "1"));
	await w.page.reload();
	await w.page.waitForLoadState("domcontentloaded");
	await expect(w.page.getByRole("textbox", { name: "Message Namzu" })).toBeVisible({ timeout: T });
	await w.page.getByRole("button", { name: "New terminal tab" }).click();
	const pane = w.page.locator("section.terminal-pane");
	await expect(pane).toBeVisible({ timeout: T });
	await w.page.locator("section.terminal-pane .xterm-helper-textarea").focus();
	await w.page.keyboard.type("echo FONT-$((6*7))");
	await w.page.keyboard.press("Enter");
	const screen = () =>
		w.page.evaluate(() => {
			const id = document.querySelector("section.terminal-pane")?.getAttribute("data-terminal-tab");
			return id ? (window.__namzuTerminals?.text(id) ?? "") : "";
		});
	await expect.poll(screen, { timeout: T }).toContain("FONT-42");
	const probe = () =>
		w.page.evaluate(async () => {
			await document.fonts.ready;
			const rows = document.querySelector("section.terminal-pane .xterm-rows");
			const screenBox = document.querySelector("section.terminal-pane .xterm-screen").getBoundingClientRect();
			const size = window.__namzuTerminals.size(
				document.querySelector("section.terminal-pane").getAttribute("data-terminal-tab"),
			);
			const root = getComputedStyle(document.documentElement);
			return {
				rowsFamily: rows ? getComputedStyle(rows).fontFamily : null,
				cellWidth: screenBox.width / size.cols,
				terminalToken: root.getPropertyValue("--font-terminal").trim(),
				faces: [...document.fonts].filter((f) => f.family === "Geist Mono").map((f) => f.status),
			};
		});
	const before = await probe();
	assert.deepEqual(before.faces, ["loaded"], "the mono face was loaded when the terminal drew");
	assert.match(before.terminalToken, /^"Geist Mono"/);
	if (before.rowsFamily !== null) assert.match(before.rowsFamily, /^"?Geist Mono"?/);
	// A cell of the shipped mono is 0.6 em at 13 px: 7.8 px, which the emulator rounds to a whole pixel
	// width. It was measured after the face was ready: a stand-in measured first would give the same
	// advance only by luck, so the face check above is what proves the wait.
	assert.ok(Math.abs(before.cellWidth - 7.8) < 0.8, `a cell is about 7.8 px wide, got ${before.cellWidth}`);

	// The interface font setting does not touch the terminal.
	await w.page.getByRole("button", { name: "Settings", exact: true }).click();
	await w.page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Appearance", exact: true }).click();
	await w.page.getByRole("group", { name: "Interface font" }).getByRole("radio", { name: /Your device’s/ }).check();
	await expect(w.page.locator("html")).toHaveAttribute("data-interface-font", "system");
	const during = await w.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-terminal").trim());
	assert.match(during, /^"Geist Mono"/);
});

/** A world whose project folder has this name, so the home heading names it. */
const named = (name) => ({
	tabs: "hidden",
	seed: (world) => {
		const to = join(dirname(world.project), name);
		renameSync(world.project, to);
		world.project = to;
	},
});

const NAME = ".composer-wrap [data-composer-heading] .home-heading-name";

async function headingLayout(w) {
	return w.page.evaluate(() => {
		const heading = document.querySelector("[data-composer-heading]");
		const name = heading.querySelector(".home-heading-name");
		const marker = (host) => {
			const probe = document.createElement("span");
			probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
			host.insertBefore(probe, host.firstChild);
			const bottom = probe.getBoundingClientRect().bottom;
			probe.remove();
			return bottom;
		};
		return {
			face: name.dataset.face,
			family: getComputedStyle(name).fontFamily,
			outside: getComputedStyle(heading).fontFamily,
			height: heading.getBoundingClientRect().height,
			baselineSentence: marker(heading),
			baselineName: marker(name),
			text: heading.textContent,
		};
	});
}

flow("the home heading draws the project's name in the display face, and the setting turns it off", named("harbor-api"), async (w) => {
	await openProject(w);
	await expect(w.page.locator(NAME)).toBeVisible({ timeout: T });
	await w.page.evaluate(() => document.fonts.ready);
	const layout = await headingLayout(w);
	assert.equal(layout.text, "What should we work on in harbor-api?");
	assert.equal(layout.face, "display");
	assert.match(layout.family, /^"Geist Pixel", Geist/);

	// Really used: the name is drawn from the shipped pixel file, and the rest of the sentence is not.
	const used = await usedFonts(w, NAME);
	assert.deepEqual(used, [{ family: "Geist Pixel Square", custom: true }]);
	assert.match(layout.outside, /^Geist,/, "the sentence around the name is set in Geist");

	// One baseline and one line: the two faces share the line without a jump in height. The heading's
	// box is the same whether the name is in the pixel face or in the interface face.
	assert.equal(layout.baselineName, layout.baselineSentence, "the name sits on the sentence's baseline");
	const heights = await w.page.evaluate(() => {
		const heading = document.querySelector("[data-composer-heading]");
		const name = heading.querySelector(".home-heading-name");
		const display = heading.getBoundingClientRect().height;
		name.dataset.face = "interface";
		const plain = heading.getBoundingClientRect().height;
		name.dataset.face = "display";
		return { display, plain };
	});
	assert.equal(heights.display, heights.plain, "the heading's height does not change with the face");

	// The pixel face is nowhere else: no other element on the page reports it as used.
	const elsewhere = await w.page.evaluate(() =>
		[...document.querySelectorAll("body *")]
			.filter((el) => !el.closest(".home-heading-name") && !el.closest("[aria-hidden='true']"))
			.filter((el) => getComputedStyle(el).fontFamily.includes("Geist Pixel"))
			.map((el) => el.tagName + "." + el.className),
	);
	assert.deepEqual(elsewhere, [], "no other text is set in the display face");

	// "Your device's": the token resolves to the interface font of the device, no pixel letters.
	await openAppearance(w);
	await w.page.getByRole("group", { name: "Interface font" }).getByRole("radio", { name: /Your device’s/ }).check();
	await expect(w.page.locator("html")).toHaveAttribute("data-interface-font", "system");
	const token = await w.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-display").trim());
	assert.doesNotMatch(token, /Geist/);
	await w.page.getByRole("button", { name: "Home", exact: true }).click();
	await expect(w.page.locator(NAME)).toBeVisible({ timeout: T });
	const system = await headingLayout(w);
	assert.doesNotMatch(system.family, /Geist/);
	const usedSystem = await usedFonts(w, NAME);
	for (const font of usedSystem) {
		assert.equal(font.custom, false, "no shipped file draws the name");
		assert.doesNotMatch(font.family, /Geist/);
	}
});

flow("a name the display face cannot draw whole stays in the interface face", named("harbor-проект"), async (w) => {
	await openProject(w);
	await expect(w.page.locator(NAME)).toBeVisible({ timeout: T });
	await w.page.evaluate(() => document.fonts.ready);
	const layout = await headingLayout(w);
	assert.equal(layout.text, "What should we work on in harbor-проект?");
	assert.equal(layout.face, "interface");
	assert.doesNotMatch(layout.family, /Pixel/);
	// The whole name, the Latin letters of it too, is in the interface face: no mix inside one name.
	const used = await usedFonts(w, NAME);
	assert.ok(used.length > 0);
	for (const font of used) assert.equal(font.family, "Geist", "every letter of the name is Geist");
	assert.equal(layout.baselineName, layout.baselineSentence);
});

flow("a Turkish project name is drawn whole in the display face", named("çağrı-işleme"), async (w) => {
	await openProject(w);
	await expect(w.page.locator(NAME)).toBeVisible({ timeout: T });
	await w.page.evaluate(() => document.fonts.ready);
	const layout = await headingLayout(w);
	assert.equal(layout.face, "display");
	const used = await usedFonts(w, NAME);
	assert.deepEqual(used, [{ family: "Geist Pixel Square", custom: true }], "one face draws every letter, dotless i included");
});
