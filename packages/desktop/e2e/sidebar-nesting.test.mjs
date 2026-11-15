// A project's conversations read as belonging to it: their titles start inside the project's own
// name line, with a guide line down from the project's folder, and a conversation started in a
// project is listed under that project. Recents stays flat. Measured on painted boxes.
// Scripted model, no paid call, no owner data.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/sidebar-nesting.test.mjs
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
	send,
} from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(process.env.SHOTS ?? join(tmpdir(), "sidebar-nesting"));
const CHATS = [{ match: /chat/, steps: [{ text: "Reply." }] }];
const GROUP = "[data-project-group]";

async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(
			new StorageEvent("storage", { key: "namzu.appearance", newValue: value }),
		);
	}, mode);
	await expect(w.page.locator("html")).toHaveClass(
		mode === "dark" ? /dark/ : /^(?!.*dark)/,
	);
}
async function resize(w, width) {
	await w.app.evaluate(({ BrowserWindow }, value) => {
		const win = BrowserWindow.getAllWindows()[0];
		win.setContentSize(value, 800);
	}, width);
	await expect
		.poll(() => w.page.evaluate(() => window.innerWidth), { timeout: T })
		.toBe(width);
}
async function shoot(w, state) {
	mkdirSync(SHOTS, { recursive: true });
	// Nothing is moving: no reply is running and no finite animation (a row sliding in, a fold) is playing.
	await expect(w.page.locator(".thread-running-indicator")).toHaveCount(0, {
		timeout: T,
	});
	await expect
		.poll(
			() =>
				w.page.evaluate(
					() =>
						document
							.getAnimations()
							.filter(
								(a) =>
									a.playState === "running" &&
									a.effect?.getComputedTiming().iterations !==
										Number.POSITIVE_INFINITY,
							).length,
				),
			{ timeout: T },
		)
		.toBe(0);
	for (const width of [1280, 900]) {
		await resize(w, width);
		for (const mode of ["dark", "light"]) {
			await theme(w, mode);
			await w.page.mouse.move(width - 5, 5);
			await expect(
				w.page.locator('[data-slot="preview-card-popup"]'),
			).toHaveCount(0, {
				timeout: T,
			});
			await w.page.screenshot({
				path: join(SHOTS, `${state}-${width}-${mode}.png`),
			});
		}
	}
	await resize(w, 1280);
	await theme(w, "dark");
}
async function addProject(w, name) {
	const dir = join(w.root, name);
	mkdirSync(join(dir, ".git"), { recursive: true });
	await w.app.evaluate((_e, path) => {
		globalThis.__e2eDialog.open = [path];
	}, dir);
	await w.page
		.getByRole("button", { name: "Add new project", exact: true })
		.last()
		.click();
	await w.page
		.getByRole("menuitem", { name: "Use an existing folder" })
		.click();
	const group = w.page.locator(GROUP).filter({ hasText: name });
	await expect(group).toHaveCount(1, { timeout: T });
	await expect(group.locator(".sidebar-project-toggle")).toHaveAttribute(
		"aria-expanded",
		"true",
		{
			timeout: T,
		},
	);
	return group;
}
/** Left edge of the first letter of an element's own text, and of its box. */
const textLeft = (loc) =>
	loc.evaluate((el) => {
		const node = [el, ...el.querySelectorAll("*")]
			.flatMap((e) => [...e.childNodes])
			.find((n) => n.nodeType === 3 && n.textContent.trim());
		const r = document.createRange();
		r.selectNodeContents(node);
		return r.getBoundingClientRect().left;
	});

test(
	"a project's conversations sit under the project, indented",
	{ timeout: 300000 },
	async () => {
		const w = await createWorld({ rules: CHATS });
		let failed = true;
		try {
			await launch(w);
			await openProject(w);
			await send(w, "chat one");
			await expect(
				w.page.getByText("Reply.", { exact: true }).first(),
			).toBeVisible({ timeout: T });
			const first = w.page.locator(GROUP).first();
			await expect(first.locator("li[data-thread-item]")).toHaveCount(1, {
				timeout: T,
			});
			// A second conversation started from the project's own "New conversation".
			await w.page
				.getByRole("button", { name: "New conversation" })
				.first()
				.click();
			await send(w, "chat two");
			await expect(first.locator("li[data-thread-item]")).toHaveCount(2, {
				timeout: T,
			});
			// Recents holds nothing the project's list already shows.
			await expect(
				w.page.locator(".sidebar-recent-list li[data-thread-item]"),
			).toHaveCount(0);
			await shoot(w, "1-expanded-two-conversations");

			const empty = await addProject(w, "emptyfolder");
			await shoot(w, "2-empty-project-added");
			// A conversation started while another project is the open one lands under that one.
			await send(w, "chat three");
			await expect(empty.locator("li[data-thread-item]")).toHaveCount(1, {
				timeout: T,
			});
			await expect(first.locator("li[data-thread-item]")).toHaveCount(2);
			const more = await addProject(w, "thirdfolder");
			await addProject(w, "fourthfolder");
			await shoot(w, "3-many-projects");

			// Collapsed: the conversations of a collapsed project are listed once, in Recents.
			await first.locator(".sidebar-project-toggle").click();
			await expect(first.locator(".sidebar-project-toggle")).toHaveAttribute(
				"aria-expanded",
				"false",
			);
			await shoot(w, "4-one-project-collapsed");
			await first.locator(".sidebar-project-toggle").click();
			await expect(first.locator(".sidebar-project-toggle")).toHaveAttribute(
				"aria-expanded",
				"true",
			);

			if (!process.env.BEFORE) {
				const name = await textLeft(first.locator(".project-row"));
				const rows = first.locator(
					"li[data-thread-item] .conversation-row-title",
				);
				for (let i = 0; i < 2; i++) {
					const title = await textLeft(rows.nth(i));
					assert.ok(
						title - name >= 10,
						`title ${i} starts ${title - name}px right of the name`,
					);
					assert.ok(
						title - name <= 24,
						`title ${i} is inset by ${title - name}px, not adrift`,
					);
				}
				const geometry = await first.evaluate((el) => {
					const folder = el
						.querySelector(".sidebar-project-folder")
						.getBoundingClientRect();
					const panel = el
						.querySelector(".sidebar-project-panel")
						.getBoundingClientRect();
					const line = el.querySelector(".sidebar-project-list");
					const rowBox = el
						.querySelector("li[data-thread-item]")
						.getBoundingClientRect();
					return {
						folderCx: folder.left + folder.width / 2,
						lineX: line.getBoundingClientRect().left,
						rowLeft: rowBox.left,
						rowHeight: rowBox.height,
						panelLeft: panel.left,
					};
				});
				assert.ok(
					Math.abs(geometry.lineX + 0.5 - geometry.folderCx) <= 1,
					`the guide line runs from the folder's centre (${geometry.lineX} vs ${geometry.folderCx})`,
				);
				assert.ok(
					geometry.rowLeft > geometry.folderCx,
					"a row begins right of the guide line",
				);
				assert.equal(
					geometry.rowHeight,
					28,
					"a conversation row keeps its 28px height",
				);
			}
			// Collapsed again, then narrow: the title still has room and the rows do not overflow.
			await first.locator(".sidebar-project-toggle").click();
			await shoot(w, "5-collapsed-again");
			await first.locator(".sidebar-project-toggle").click();
			await resize(w, 700);
			await w.page.screenshot({ path: join(SHOTS, "6-narrow-700-dark.png") });
			const overflow = await w.page.evaluate(() => {
				const s = document.querySelector(".sidebar-scroll");
				return s.scrollWidth - s.clientWidth;
			});
			assert.ok(
				overflow <= 0,
				`the list does not scroll sideways (${overflow}px)`,
			);
			void more;
			assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	},
);
