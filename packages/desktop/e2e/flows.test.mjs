// P0 flows against the real Electron app, the real CLI host and a scripted model.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test packages/desktop/e2e/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	createWorld,
	dialogsSeen,
	dispose,
	expect,
	instrumentFrames,
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
		await card.getByRole("button", { name: "Tell Namzu what to do instead", exact: true }).click();
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

/** Settings opens as a page of its own; a section is chosen from its left column. */
async function openSettings(w, section) {
	if ((await w.page.getByRole("heading", { level: 1, name: "Settings" }).count()) === 0)
		await w.page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		w.page.getByRole("heading", { level: 1, name: "Settings" }),
	).toBeVisible({ timeout: T });
	await w.page
		.getByRole("navigation", { name: "Settings sections" })
		.getByRole("button", { name: section, exact: true })
		.click();
	await expect(
		w.page.getByRole("heading", { level: 2, name: section, exact: true }),
	).toBeVisible({ timeout: T });
}
const removeDialog = (w) => w.page.getByRole("alertdialog");

flow(
	"Ctrl+, opens Settings, and a search result leads to its section",
	{},
	async (w) => {
		await openProject(w);
		await w.page.keyboard.press("Control+,");
		await expect(
			w.page.getByRole("heading", { level: 1, name: "Settings" }),
		).toBeVisible({ timeout: T });
		const search = w.page.getByRole("searchbox", { name: "Search settings" });
		await search.fill("theme");
		await expect(w.page.getByText("1 result")).toBeVisible({ timeout: T });
		await w.page.getByRole("button", { name: /^Theme/ }).click();
		await expect(
			w.page.getByRole("heading", { level: 2, name: "Appearance" }),
		).toBeVisible({ timeout: T });
		await expect(w.page.getByRole("radio", { name: /Dark/ })).toBeChecked();
	},
);

flow(
	"a settings change is saved by main and is still there after a restart",
	{},
	async (w) => {
		await openProject(w);
		await openSettings(w, "General");
		await w.page.getByRole("radio", { name: /Start on the home screen/ }).check();
		await openSettings(w, "Projects");
		const ask = w.page.getByRole("switch", {
			name: "Ask again when a project’s automatic settings change",
		});
		await expect(ask).toBeChecked();
		// Turning the check off asks in the app, never in a native box; Cancel keeps it on.
		await ask.uncheck();
		const confirm = w.page.getByRole("dialog", {
			name: "Stop asking when a folder’s automatic settings change?",
		});
		await expect(confirm).toBeVisible();
		await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
		await confirm.getByRole("button", { name: "Cancel" }).click();
		await expect(confirm).toBeHidden();
		await expect(ask).toBeChecked();
		assert.deepEqual(await dialogsSeen(w), []);
		await ask.uncheck();
		await confirm.getByRole("button", { name: "Turn off" }).click();
		await expect(confirm).toBeHidden();
		await expect(ask).not.toBeChecked();
		await openSettings(w, "Updates");
		await w.page
			.getByRole("switch", { name: "Download updates automatically" })
			.uncheck();
		const file = join(w.userData, "desktop-settings.json");
		await expect
			.poll(() => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null))
			.toEqual({
				version: 1,
				startup: "home",
				retrustOnConfigChange: false,
				autoDownloadUpdates: false,
				// The terminal settings are saved with their defaults beside the ones changed here.
				restoreTerminals: true,
				terminalShell: "auto",
			});
		await relaunch(w);
		await w.page.getByRole("button", { name: "Settings", exact: true }).click();
		await openSettings(w, "General");
		await expect(
			w.page.getByRole("radio", { name: /Start on the home screen/ }),
		).toBeChecked({ timeout: T });
		await openSettings(w, "Projects");
		await expect(
			w.page.getByRole("switch", {
				name: "Ask again when a project’s automatic settings change",
			}),
		).not.toBeChecked();
		await openSettings(w, "Updates");
		await expect(
			w.page.getByRole("switch", { name: "Download updates automatically" }),
		).not.toBeChecked();
	},
);

flow(
	"removing a project keeps its files and journals, untrusts the folder, and adding it back lists its conversations",
	{ rules: CHATS },
	async (w) => {
		await twoChats(w);
		const trustFile = join(w.home, "trust.json");
		assert.equal(JSON.parse(readFileSync(trustFile, "utf8")).trusted.length, 1);
		await openSettings(w, "Projects");
		await w.page.getByRole("button", { name: "Remove project…", exact: true }).click();
		const dialog = removeDialog(w);
		await expect(dialog.getByText("Remove \u201cproject\u201d from Namzu?")).toBeVisible({
			timeout: T,
		});
		await expect(dialog).toContainText("off Namzu\u2019s trusted list");
		await expect(dialog).toContainText(
			"Files on your computer and existing conversations won\u2019t be deleted.",
		);
		await dialog.getByRole("button", { name: "Remove project", exact: true }).click();
		await expect(w.page.getByText("No projects yet.")).toBeVisible({ timeout: T });
		// The folder left the trust list; nothing on disk was deleted.
		assert.deepEqual(JSON.parse(readFileSync(trustFile, "utf8")).trusted, []);
		assert.equal(existsSync(join(w.project, ".git")), true);
		assert.equal(existsSync(join(w.project, "namzu.config.json")), true);
		assert.equal(journalsMentioning(w, "alpha chat").length, 1);
		assert.deepEqual(
			JSON.parse(readFileSync(join(w.userData, "projects.json"), "utf8")),
			[],
		);
		// Gone after a restart too: it is not brought back from the saved window state.
		await relaunch(w);
		await expect(
			w.page.getByRole("button", { name: "Add new project", exact: true }).first(),
		).toBeVisible({ timeout: T });
		await expect(sidebarRow(w, "alpha chat")).toHaveCount(0);
		// Adding the same folder back asks for trust again and restores its conversations.
		await openProject(w);
		await expect(sidebarRow(w, "alpha chat")).toBeVisible({ timeout: T });
		await expect(sidebarRow(w, "beta chat")).toBeVisible({ timeout: T });
		await sidebarRow(w, "alpha chat").click();
		await expect(w.page.getByText("Reply alpha.")).toBeVisible({ timeout: T });
	},
);

flow(
	"a project with a reply still running refuses to be removed, then goes once it finishes",
	{
		rules: [
			{ match: /slow/, steps: [{ hold: "slow", text: "Slow reply done." }] },
		],
	},
	async (w) => {
		await openProject(w);
		await send(w, "slow request");
		await expect(w.page.getByRole("button", { name: "Stop" }).first()).toBeVisible({
			timeout: T,
		});
		await openSettings(w, "Projects");
		await w.page.getByRole("button", { name: "Remove project…", exact: true }).click();
		const dialog = removeDialog(w);
		await dialog.getByRole("button", { name: "Remove project", exact: true }).click();
		await expect(dialog.getByRole("alert")).toContainText("still running", {
			timeout: T,
		});
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(
			w.page.getByRole("button", { name: "Remove project…", exact: true }),
		).toBeVisible();
		w.model.release("slow");
		// The turn ends on its own after the release; each pass retries the removal until it is accepted.
		await expect(async () => {
			if ((await w.page.getByText("No projects yet.").count()) === 0) {
				if ((await removeDialog(w).count()) === 0)
					await w.page
						.getByRole("button", { name: "Remove project…", exact: true })
						.click({ timeout: 3000 });
				await removeDialog(w)
					.getByRole("button", { name: "Remove project", exact: true })
					.click({ timeout: 3000 });
			}
			await expect(w.page.getByText("No projects yet.")).toBeVisible({
				timeout: 5000,
			});
		}).toPass({ timeout: T });
	},
);

/** The conversation is on disk once the app has written it, so a relaunch can restore it. */
async function savedConversation(w, title) {
	await expect
		.poll(
			() => {
				try {
					return readFileSync(
						join(w.userData, "desktop-conversations.json"),
						"utf8",
					).includes(title);
				} catch {
					return false;
				}
			},
			{ timeout: T },
		)
		.toBe(true);
}

flow(
	"a restart restores the same tab and paints no home, welcome or empty frame on the way",
	{
		rules: [{ match: /hello/, steps: [{ text: "Scripted hello back." }] }],
	},
	async (w) => {
		await openProject(w);
		await send(w, "hello there");
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({
			timeout: T,
		});
		await savedConversation(w, "hello there");
		await w.app.close();
		instrumentFrames(w);
		await launch(w);
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({
			timeout: T,
		});
		const frames = await w.page.evaluate(() => window.__frames);
		console.log(
			`startup frames (ms from navigation start):\n${frames.map((f) => JSON.stringify(f)).join("\n")}`,
		);
		assert.ok(frames.some((f) => f.skeleton), "a skeleton stood in for the tab");
		const shown = frames.filter((f) => f.root > 0);
		for (const frame of shown) {
			assert.equal(frame.welcome, false, `no welcome frame: ${JSON.stringify(frame)}`);
			assert.equal(frame.heading, false, `no home heading frame: ${JSON.stringify(frame)}`);
			assert.ok(
				frame.skeleton || frame.hello,
				`every painted frame is the skeleton or the conversation: ${JSON.stringify(frame)}`,
			);
			assert.equal(frame.dark, true, "the saved theme is on from the first paint");
		}
		assert.ok(frames.at(-1).hello, "the last frame is the restored conversation");
	},
);

flow(
	"start on the home screen keeps the tab in the strip and opens it when picked",
	{
		rules: [{ match: /hello/, steps: [{ text: "Scripted hello back." }] }],
	},
	async (w) => {
		await openProject(w);
		await send(w, "hello there");
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({
			timeout: T,
		});
		await savedConversation(w, "hello there");
		await w.app.close();
		writeFileSync(
			join(w.userData, "desktop-settings.json"),
			JSON.stringify({ version: 1, startup: "home" }),
		);
		await launch(w);
		await expect(
			w.page.getByRole("textbox", { name: "Message Namzu" }),
		).toBeVisible({ timeout: T });
		await expect(w.page.locator(".conversation-tab")).toHaveCount(1);
		await expect(w.page.getByText("Scripted hello back.")).toHaveCount(0);
		// A tab can be picked once its conversation is known, which is when it carries its title.
		await expect(w.page.locator(".conversation-tab").first()).toContainText(
			"hello there",
			{ timeout: T },
		);
		await w.page.locator(".conversation-tab").first().click();
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({
			timeout: T,
		});
	},
);

flow(
	"a restored tab whose journal is gone closes and shows the project home, without Electron's words",
	{
		rules: [{ match: /hello/, steps: [{ text: "Scripted hello back." }] }],
	},
	async (w) => {
		await openProject(w);
		await send(w, "hello there");
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({
			timeout: T,
		});
		await savedConversation(w, "hello there");
		await w.app.close();
		const journals = journalsMentioning(w, "hello there");
		assert.equal(journals.length, 1);
		rmSync(journals[0]);
		await launch(w);
		await expect(w.page.locator(".conversation-tab")).toHaveCount(0, {
			timeout: T,
		});
		await expect(
			w.page.getByRole("textbox", { name: "Message Namzu" }),
		).toBeVisible({ timeout: T });
		const text = await w.page.locator("body").innerText();
		assert.ok(!/Error invoking remote method/.test(text), "no IPC prefix on screen");
		assert.ok(!/could not be loaded/.test(text), "no load banner on screen");
	},
);

const HOOKS = { sandbox: { enabled: false }, hooks: { PreToolUse: [] } };

flow(
	"a change to a trusted folder's automatic settings asks for trust again, and only once",
	{
		rules: [{ match: /hello/, steps: [{ text: "Scripted hello back." }] }],
	},
	async (w) => {
		await openProject(w);
		await send(w, "hello there");
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({
			timeout: T,
		});
		await savedConversation(w, "hello there");
		await w.app.close();
		writeFileSync(
			join(w.project, "namzu.config.json"),
			JSON.stringify({ sandbox: { enabled: false }, mcpServers: { x: { command: "x" } } }),
		);
		await launch(w);
		const dialog = w.page.getByRole("dialog", { name: "Trust this folder?" });
		await expect(dialog).toBeVisible({ timeout: T });
		await expect(dialog).toContainText("changed since you last trusted it");
		await expect(dialog).toContainText("MCP servers added");
		// Until it is answered the folder behaves as untrusted: no conversation, no composer.
		await expect(w.page.getByText("Scripted hello back.")).toHaveCount(0);
		await expect(
			w.page.getByRole("textbox", { name: "Message Namzu" }),
		).toHaveCount(0);
		await dialog.getByRole("button", { name: "Trust and open" }).click();
		// Trust takes main's token, so a second dialog lists what the folder runs, with the
		// change first; nothing is trusted on the renderer's word alone.
		await expect(dialog).toContainText("start programs on their own", { timeout: T });
		await expect(dialog.getByRole("listitem").first()).toContainText(
			"MCP servers added",
		);
		await dialog.getByRole("button", { name: "Trust and open" }).click();
		await expect(dialog).toHaveCount(0);
		await w.page.locator(".conversation-tab").first().click();
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({
			timeout: T,
		});
		await relaunch(w);
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({
			timeout: T,
		});
		await expect(
			w.page.getByRole("dialog", { name: "Trust this folder?" }),
		).toHaveCount(0);
	},
);

flow(
	"with the re-prompt setting off a changed folder opens as before",
	{
		rules: [{ match: /hello/, steps: [{ text: "Scripted hello back." }] }],
	},
	async (w) => {
		await openProject(w);
		await send(w, "hello there");
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({
			timeout: T,
		});
		await savedConversation(w, "hello there");
		await w.app.close();
		writeFileSync(
			join(w.userData, "desktop-settings.json"),
			JSON.stringify({ version: 1, retrustOnConfigChange: false }),
		);
		writeFileSync(join(w.project, "namzu.config.json"), JSON.stringify(HOOKS));
		await launch(w);
		await expect(w.page.getByText("Scripted hello back.")).toBeVisible({
			timeout: T,
		});
		await expect(
			w.page.getByRole("dialog", { name: "Trust this folder?" }),
		).toHaveCount(0);
	},
);
