// Errors at the root against the real Electron app, the real CLI host and the scripted model: a
// folder that is gone, attachments that cannot be attached, and a project whose restored tabs
// cannot open. None of them may show an error name, a code or a developer sentence.
// Pictures go to research/hygiene-20261010/errors-root/ (900 and 1280 px, dark and light).
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-errors-root.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createWorld, dispose, expect, launch, openProject, repoRoot } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/hygiene-20261010/errors-root");
const RAW = /Error invoking|ENOENT|EPERM|EACCES|realpath|SupersededConversation|[A-Za-z]+Error\b|UTF-8|MiB|KiB|\[object|undefined/;

function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		const world = await createWorld(options);
		let failed = true;
		try {
			await launch(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	});
}

async function setAppearance(w, value) {
	await w.page.evaluate((next) => {
		localStorage.setItem("namzu.appearance", next);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: next }));
	}, value);
	await expect(w.page.locator("html")).toHaveClass(value === "dark" ? /dark/ : /^(?!.*dark)/);
}

async function size(w, width) {
	await w.app.evaluate(({ BrowserWindow }, px) => {
		for (const win of BrowserWindow.getAllWindows()) win.setSize(px, 820);
	}, width);
	await expect.poll(() => w.page.evaluate(() => window.innerWidth)).toBeGreaterThan(width - 60);
}

async function settled(w) {
	await w.page.evaluate(async () => {
		const ending = document
			.getAnimations()
			.filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
		await Promise.all(ending.map((a) => a.finished.catch(() => undefined)));
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
}

/** One picture per width and scheme, named for what it shows. */
async function shots(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	for (const scheme of ["dark", "light"]) {
		await setAppearance(w, scheme);
		for (const width of [900, 1280]) {
			await size(w, width);
			await settled(w);
			await w.page.screenshot({ path: join(SHOTS, `${name}-${width}-${scheme}.png`) });
		}
	}
}

const pickNext = (w, ...paths) =>
	w.app.evaluate((_e, list) => {
		globalThis.__e2eDialog.open = list;
	}, paths);

const bodyText = (w) => w.page.evaluate(() => document.body.innerText);

flow("a folder that is gone is one plain sentence and opens no blank tab", {}, async (w) => {
	await expect(w.page.getByRole("button", { name: "Add new project", exact: true }).first()).toBeVisible({
		timeout: T,
	});
	await pickNext(w, join(w.root, "no-such-folder"));
	await w.page.getByRole("button", { name: "Add new project", exact: true }).last().click();
	await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
	const banner = w.page.getByRole("alert").filter({ hasText: "That folder no longer exists." });
	await expect(banner).toBeVisible({ timeout: T });
	await expect(banner).toContainText("Choose another folder.");
	assert.doesNotMatch(await bodyText(w), RAW, "no code, class name or call name on screen");
	await expect(w.page.getByRole("tab")).toHaveCount(0);
	await shots(w, "folder-gone");
});

flow("a file that cannot be attached names the file and the limit in plain words", {}, async (w) => {
	await openProject(w);
	const big = join(w.root, "big_notes.txt");
	writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 65));
	const binary = join(w.root, "bin.dat");
	writeFileSync(binary, Buffer.from([0, 1, 2, 3, 255, 254]));
	const attach = async () => {
		await w.page.getByRole("button", { name: "Attachments and message settings" }).click();
		await w.page.getByRole("button", { name: "Attach files" }).click();
	};
	await pickNext(w, big);
	await attach();
	const tooBig = w.page.getByRole("alert").filter({ hasText: "big_notes.txt" });
	await expect(tooBig).toBeVisible({ timeout: T });
	await expect(tooBig).toContainText("is 6 MB. Choose a file under 3 MB.");
	assert.doesNotMatch(await bodyText(w), RAW);
	await shots(w, "attach-too-big");
	await pickNext(w, binary);
	await attach();
	const notText = w.page.getByRole("alert").filter({ hasText: "bin.dat" });
	await expect(notText).toBeVisible({ timeout: T });
	await expect(notText).toContainText("can’t be attached. Namzu reads images and text files.");
	assert.doesNotMatch(await bodyText(w), RAW);
	await shots(w, "attach-not-text");
});

flow(
	"restored tabs of a project whose folder is gone show that project’s own page and no banner",
	{ rules: [{ match: /hello/, steps: [{ text: "Scripted hello back." }] }] },
	async (w) => {
		await openProject(w);
		for (const text of ["hello one", "hello two"]) {
			if (text === "hello two") {
				await w.page.getByRole("button", { name: "New conversation" }).first().click();
			}
			const box = w.page.getByRole("textbox", { name: "Message Namzu" });
			await box.fill(text);
			await w.page.getByRole("button", { name: "Send message" }).click();
			await expect(w.page.getByText("Scripted hello back.").last()).toBeVisible({ timeout: T });
		}
		await w.app.close();
		renameSync(w.project, join(w.root, "moved-project"));
		await launch(w);
		await expect(w.page.locator("[data-project-missing]")).toBeVisible({ timeout: T });
		const page = w.page.locator("[data-project-folder-missing]");
		await expect(page).toBeVisible({ timeout: T });
		await expect(page.getByRole("button", { name: /Locate folder/ })).toBeVisible();
		const text = await bodyText(w);
		assert.doesNotMatch(text, /could not be loaded|Retry setup/);
		const untitled = await w.page.getByRole("tab", { name: /^New conversation/ }).count();
		assert.ok(untitled <= 1, `restored tabs did not pile up as identical blank ones (${untitled})`);
		await shots(w, "project-missing");
	},
);
