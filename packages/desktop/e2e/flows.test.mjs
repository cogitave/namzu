// P0 flows against the real Electron app, the real CLI host and a scripted model.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test packages/desktop/e2e/
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	createWorld,
	dialogsSeen,
	dispose,
	expect,
	launch,
	openProject,
	relaunch,
	send,
} from "./harness.mjs";

const T = 60000;

/** One isolated world per flow; artifacts are kept and printed only when the flow fails. */
function flow(name, options, body) {
	test(name, { timeout: 180000 }, async () => {
		const world = await createWorld(options);
		let failed = true;
		try {
			await launch(world);
			await body(world);
			assert.deepEqual(
				world.faults,
				[],
				"the renderer raised no uncaught errors",
			);
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	});
}

const WRITE = {
	match: /write the file/i,
	steps: [
		{
			tool: "write",
			args: { path: "out.txt", content: "hello from the model\n" },
		},
		{ text: "Wrote out.txt." },
	],
};

// The native picker is the consent for an ordinary folder: main trusts it right after the pick
// and no second, native confirmation appears. (A broad folder or a known untrusted one asks in
// the app instead; main/folder-access.test.ts and renderer/folder-access-dialog.test.ts cover those.)
flow("picking a folder trusts it with no native confirmation", {}, async (w) => {
	await openProject(w);
	assert.deepEqual(await dialogsSeen(w), []);
	assert.equal(
		await w.page.getByRole("button", { name: "Review folder access" }).count(),
		0,
	);
});

flow(
	"a new conversation gets the scripted reply",
	{ rules: [{ match: /hello/, steps: [{ text: "Scripted hello back." }] }] },
	async (w) => {
		await openProject(w);
		await send(w, "hello there");
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({
			timeout: T,
		});
		assert.equal(w.model.requests.length >= 1, true);
	},
);

flow(
	"a tool call needing approval: Accept runs it",
	{ rules: [WRITE] },
	async (w) => {
		await openProject(w);
		await send(w, "Please write the file");
		const card = w.page.getByRole("region", { name: "Tool approval" });
		await expect(card).toBeVisible({ timeout: T });
		assert.equal(
			existsSync(join(w.project, "out.txt")),
			false,
			"nothing is written before approval",
		);
		await card.getByRole("button", { name: "Accept", exact: true }).click();
		await expect(w.page.getByText("Wrote out.txt.")).toBeVisible({
			timeout: T,
		});
		assert.equal(
			readFileSync(join(w.project, "out.txt"), "utf8"),
			"hello from the model\n",
		);
	},
);

flow(
	"a tool call needing approval: Reject writes nothing and the model is told",
	{ rules: [WRITE] },
	async (w) => {
		await openProject(w);
		await send(w, "Please write the file");
		const card = w.page.getByRole("region", { name: "Tool approval" });
		await expect(card).toBeVisible({ timeout: T });
		await card.getByRole("button", { name: "Reject", exact: true }).click();
		await expect(card).toHaveCount(0, { timeout: T });
		await expect
			.poll(() => w.model.requests.length, { timeout: T })
			.toBeGreaterThanOrEqual(2);
		assert.equal(existsSync(join(w.project, "out.txt")), false);
	},
);

flow(
	"a tool call needing approval: Edit sends a note instead of running it",
	{ rules: [WRITE] },
	async (w) => {
		await openProject(w);
		await send(w, "Please write the file");
		const card = w.page.getByRole("region", { name: "Tool approval" });
		await expect(card).toBeVisible({ timeout: T });
		await card.getByRole("button", { name: "Edit", exact: true }).click();
		await card
			.getByRole("textbox", { name: "Tell Namzu what to do instead" })
			.fill("use notes.txt instead");
		await card.getByRole("button", { name: "Send", exact: true }).click();
		await expect(card).toHaveCount(0, { timeout: T });
		await expect
			.poll(() => JSON.stringify(w.model.requests.at(-1)?.messages ?? []), {
				timeout: T,
			})
			.toContain("use notes.txt instead");
		assert.equal(existsSync(join(w.project, "out.txt")), false);
	},
);

flow("undo a reply's file change", { rules: [WRITE] }, async (w) => {
	await openProject(w);
	await send(w, "Please write the file");
	const card = w.page.getByRole("region", { name: "Tool approval" });
	await expect(card).toBeVisible({ timeout: T });
	await card.getByRole("button", { name: "Accept", exact: true }).click();
	await expect(w.page.getByText("Wrote out.txt.")).toBeVisible({ timeout: T });
	await w.page.getByRole("button", { name: "Undo", exact: true }).click();
	const dialog = w.page.getByRole("dialog");
	await expect(dialog.getByText("Undo this reply’s file changes?")).toBeVisible(
		{ timeout: T },
	);
	await dialog.getByRole("button", { name: /^Undo/ }).last().click();
	await expect(dialog.getByText("Undo finished")).toBeVisible({ timeout: T });
	assert.equal(
		existsSync(join(w.project, "out.txt")),
		false,
		"the created file is removed again",
	);
});

const CHATS = [
	{ match: /alpha/, steps: [{ text: "Reply alpha." }] },
	{ match: /beta/, steps: [{ text: "Reply beta." }] },
];

/** Two finished conversations, alpha then beta, with beta open. */
async function twoChats(w) {
	await openProject(w);
	await send(w, "alpha chat");
	await expect(w.page.getByText("Reply alpha.")).toBeVisible({ timeout: T });
	await w.page.getByRole("button", { name: "New conversation tab" }).click();
	await send(w, "beta chat");
	await expect(w.page.getByText("Reply beta.")).toBeVisible({ timeout: T });
}
const sidebar = (w) => w.page.locator("nav.conversations");
// A sidebar row's menu opens on right-click (the row's own buttons are Pin and Archive).
const rowActions = (w, title) =>
	sidebar(w).getByRole("button", { name: title, exact: true }).first();
const sidebarRow = (w, title) =>
	sidebar(w).getByRole("button", { name: title, exact: true });

async function archive(w, title) {
	await rowActions(w, title).click({ button: "right" });
	await w.page.getByRole("menuitem", { name: /^Archive/ }).click();
	// A row's Archive has an Undo path, so it archives at once with no confirmation.
	await expect(w.page.getByText("Conversation archived.")).toBeVisible({
		timeout: T,
	});
	await expect(sidebarRow(w, title)).toHaveCount(0, { timeout: T });
}
async function openArchived(w) {
	await w.page.getByRole("button", { name: "Conversation details" }).click();
	await w.page.getByRole("button", { name: "Project actions" }).click();
	await w.page
		.getByRole("menuitem", { name: "Archived conversations" })
		.click();
	return w.page.getByRole("dialog", { name: "Archived conversations" });
}

flow(
	"archive, find it under Archived, restore it, then archive it again",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		await archive(w, "alpha chat");
		await expect(sidebarRow(w, "beta chat")).toBeVisible();
		let list = await openArchived(w);
		await expect(list.getByText("alpha chat")).toBeVisible({ timeout: T });
		await list.getByRole("button", { name: "Restore alpha chat" }).click();
		await expect(
			list.getByText("Nothing is archived in this project."),
		).toBeVisible({ timeout: T });
		await list.getByRole("button", { name: "Close", exact: true }).click();
		await expect(sidebarRow(w, "alpha chat")).toBeVisible({ timeout: T });
		// The restored row must be removable again: this is the path that used to fail.
		await archive(w, "alpha chat");
		list = await openArchived(w);
		await expect(list.getByText("alpha chat")).toBeVisible({ timeout: T });
	},
);

flow(
	"there is no delete: archiving is the way a conversation leaves the list",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		await rowActions(w, "alpha chat").click({ button: "right" });
		let items = await w.page.getByRole("menuitem").allTextContents();
		await w.page.keyboard.press("Escape");
		await openFullMenu(w);
		items = items.concat(await w.page.getByRole("menuitem").allTextContents());
		assert.equal(
			items.some((t) => /delete/i.test(t)),
			false,
			`menu: ${items.join(" | ")}`,
		);
		assert.equal(
			items.some((t) => /^Archive/.test(t)),
			true,
		);
	},
);

/** The full conversation menu belongs to the open conversation; the sidebar row's menu only archives. */
async function openFullMenu(w) {
	await w.page
		.getByRole("button", { name: "Conversation actions", exact: true })
		.click();
}

flow(
	"rename and pin a conversation, and both survive a restart",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		await sidebarRow(w, "alpha chat").click();
		await expect(w.page.getByText("Reply alpha.")).toBeVisible({ timeout: T });
		await openFullMenu(w);
		await w.page.getByRole("menuitem", { name: /^Rename/ }).click();
		await w.page
			.getByRole("textbox", { name: "Conversation name" })
			.fill("Renamed alpha");
		await w.page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(sidebarRow(w, "Renamed alpha")).toBeVisible({ timeout: T });
		await openFullMenu(w);
		await w.page.getByRole("menuitem", { name: "Pin", exact: true }).click();
		await openFullMenu(w);
		await expect(
			w.page.getByRole("menuitem", { name: "Unpin", exact: true }),
		).toBeVisible({ timeout: T });
		await w.page.keyboard.press("Escape");
		await relaunch(w);
		await expect(sidebarRow(w, "Renamed alpha")).toBeVisible({ timeout: T });
		await sidebarRow(w, "Renamed alpha").click();
		await openFullMenu(w);
		await expect(
			w.page.getByRole("menuitem", { name: "Unpin", exact: true }),
		).toBeVisible({ timeout: T });
	},
);

const MANY_MODELS = [
	"gpt-6",
	"gpt-6-mini",
	"gpt-5.6",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-4.1",
	"gpt-4o",
];

flow(
	"switch the model in the picker; older models sit behind a fold",
	{
		model: "gpt-6",
		models: MANY_MODELS,
		rules: [{ match: /hello/, steps: [{ text: "Scripted hello back." }] }],
	},
	async (w) => {
		await openProject(w);
		await w.page.getByRole("button", { name: /^Model:/ }).click();
		const fold = w.page.getByRole("button", { name: /^Older models \(\d+\)/ });
		await expect(fold).toBeVisible({ timeout: T });
		await expect(w.page.getByRole("radio", { name: /gpt-4\.1/ })).toHaveCount(
			0,
		);
		await fold.click();
		await w.page.getByRole("radio", { name: /gpt-4\.1/ }).click();
		await w.page.keyboard.press("Escape");
		await expect(
			w.page.getByRole("button", { name: /^Model: .*gpt-4\.1/ }),
		).toBeVisible({ timeout: T });
		await send(w, "hello there");
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({
			timeout: T,
		});
		assert.equal(
			w.model.requests.at(-1).model,
			"gpt-4.1",
			"the turn ran on the chosen model",
		);
	},
);

const PLAN = {
	match: /make a plan/i,
	steps: [
		{
			tool: "task_create",
			args: { subject: "Write the parser", activeForm: "Writing the parser" },
		},
		{
			tool: "task_create",
			args: { subject: "Add the tests", activeForm: "Adding the tests" },
		},
		{ text: "Plan is ready." },
	],
};

flow(
	"the plan row shows the tasks the model created",
	{ rules: [PLAN] },
	async (w) => {
		await openProject(w);
		await send(w, "Please make a plan");
		await expect(w.page.getByText("Plan is ready.")).toBeVisible({
			timeout: T,
		});
		// The plan sits inside the folded work summary of the turn.
		const worked = w.page.getByRole("button", { name: /^Worked for/ });
		if ((await worked.getAttribute("aria-expanded")) !== "true")
			await worked.click();
		await expect(worked).toHaveAttribute("aria-expanded", "true");
		const trigger = w.page.locator(".plan-trigger");
		await expect(trigger).toBeVisible({ timeout: T });
		assert.match(
			await trigger.textContent(),
			/2/,
			"the plan row counts both tasks",
		);
		await trigger.click();
		const steps = w.page.getByRole("list", { name: "Plan" });
		await expect(steps.getByText("Write the parser")).toBeVisible({
			timeout: T,
		});
		await expect(steps.getByText("Add the tests")).toBeVisible({ timeout: T });
	},
);

flow(
	"reopening the app finds the history intact",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		await relaunch(w);
		await expect(sidebarRow(w, "alpha chat")).toBeVisible({ timeout: T });
		await expect(sidebarRow(w, "beta chat")).toBeVisible({ timeout: T });
		await sidebarRow(w, "alpha chat").click();
		await expect(w.page.getByText("Reply alpha.")).toBeVisible({ timeout: T });
		await sidebarRow(w, "beta chat").click();
		await expect(w.page.getByText("Reply beta.")).toBeVisible({ timeout: T });
	},
);

/** Every saved journal under the temp home that mentions this text. */
function journalsMentioning(w, text) {
	const found = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (
				entry.name.endsWith(".jsonl") &&
				readFileSync(path, "utf8").includes(text)
			)
				found.push(path);
		}
	};
	walk(join(w.home, "projects"));
	return found;
}

flow(
	"a row whose saved journal is gone can still be archived",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		await w.app.close();
		const journals = journalsMentioning(w, "alpha chat");
		assert.equal(journals.length, 1);
		rmSync(journals[0]);
		await relaunch(w);
		await expect(sidebarRow(w, "beta chat")).toBeVisible({ timeout: T });
		// The sidebar still lists it from the saved catalogue, so the row must be removable.
		await expect(sidebarRow(w, "alpha chat")).toBeVisible({ timeout: T });
		await archive(w, "alpha chat");
		await relaunch(w);
		await expect(sidebarRow(w, "beta chat")).toBeVisible({ timeout: T });
		await expect(sidebarRow(w, "alpha chat")).toHaveCount(0);
	},
);
