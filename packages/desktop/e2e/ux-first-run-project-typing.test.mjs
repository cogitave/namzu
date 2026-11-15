// First run on a new machine: a project is added by each path a new person takes, and the message
// box takes keys in it, also after going to another conversation and back to the project by its
// name in the sidebar. Set TYPING_SHOTS=<dir> to write a picture of each step.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-first-run-project-typing.test.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch } from "./harness.mjs";

const T = 60000;
const SHOTS = process.env.TYPING_SHOTS;

async function shot(w, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
const box = (w) => w.page.getByRole("textbox", { name: "Message Namzu" });

/** Keys reach the box: it is enabled, a click focuses it and what is typed is what it holds. */
async function typesInto(w, name) {
	await expect(box(w)).toBeVisible({ timeout: T });
	await shot(w, name);
	await expect(box(w)).toBeEnabled({ timeout: T });
	await box(w).click();
	await w.page.keyboard.type("hello there");
	await expect(box(w)).toHaveValue("hello there");
	await shot(w, `${name}-typed`);
	await box(w).fill("");
}

const addButton = (w) => w.page.getByRole("button", { name: "Add new project", exact: true });
async function addFolder(w) {
	await addButton(w).last().click();
	await w.page.getByRole("menuitem", { name: "Use an existing folder" }).click();
	await w.page
		.getByRole("dialog", { name: "Trust this folder?" })
		.getByRole("button", { name: "Trust and open" })
		.click();
}
const projectRow = (w) => w.page.locator("[data-project-group]").first().getByText("project", { exact: true });

const FLOWS = {
	"a folder added from the home screen": async (w) => {
		await addFolder(w);
		await typesInto(w, "folder-added");
	},
	"a project started from scratch": async (w) => {
		await addButton(w).last().click();
		await w.page.getByRole("menuitem", { name: "Start from scratch" }).click();
		await typesInto(w, "from-scratch");
	},
	"a project's name clicked after a new conversation in it": async (w) => {
		await addFolder(w);
		await typesInto(w, "project-first");
		await w.page.getByRole("button", { name: "New conversation" }).first().click();
		await typesInto(w, "new-conversation");
		await projectRow(w).click();
		await typesInto(w, "project-name-clicked");
	},
	"a project's name clicked after two new conversations in it": async (w) => {
		await addFolder(w);
		await expect(box(w)).toBeVisible({ timeout: T });
		await w.page.getByRole("button", { name: "New conversation" }).first().click();
		await w.page.getByRole("button", { name: "New conversation" }).first().click();
		await typesInto(w, "two-new-conversations");
		await projectRow(w).click();
		await typesInto(w, "project-name-clicked-twice");
	},
};

for (const tabs of ["hidden", "shown"]) {
	for (const [name, body] of Object.entries(FLOWS)) {
		test(`first run, conversation tabs ${tabs}: ${name}`, { timeout: 240000 }, async () => {
			const w = await createWorld({ noKey: true, noPrefs: true, rules: [], tabs });
			let failed = true;
			try {
				await launch(w);
				await expect(addButton(w).first()).toBeVisible({ timeout: T });
				await body(w);
				assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
				failed = false;
			} finally {
				await dispose(w, { failed });
			}
		});
	}
}
