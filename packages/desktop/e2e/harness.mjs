// Real-Electron harness for Namzu Desktop. No paid model, no owner data:
// a frozen copy of dist/, a temp userData, a temp NAMZU_HOME and a temp HOME,
// the real CLI host (packages/cli/dist) and a scripted local model server.
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "./fake-model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const desktopRoot = resolve(here, "..");
export const repoRoot = resolve(desktopRoot, "../..");
const require = createRequire(join(desktopRoot, "package.json"));
const { _electron, expect } = require("@playwright/test");
export { expect };

// Only what a display and a shell need is inherited; no credential variable of the caller reaches the app.
const INHERIT =
	/^(PATH|DISPLAY|XAUTHORITY|LANG|LC_[A-Z_]+|TMPDIR|TERM|TZ|SHELL|USER|LOGNAME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|WSL_DISTRO_NAME|WSL_INTEROP)$/;

/** Freeze dist/ so a sibling rebuild cannot pull files out from under a run. */
export function freezeApp(root) {
	const app = join(root, "app");
	if (existsSync(app)) return app;
	mkdirSync(app, { recursive: true });
	cpSync(join(desktopRoot, "dist"), join(app, "dist"), { recursive: true });
	cpSync(join(desktopRoot, "package.json"), join(app, "package.json"));
	symlinkSync(
		join(desktopRoot, "node_modules"),
		join(app, "node_modules"),
		"dir",
	);
	return app;
}

/**
 * @param {{ rules?: any[], seed?: (ctx: any) => Promise<void> | void, models?: string[], keepRoot?: string, files?: Record<string,string> }} opts
 */
export async function createWorld(opts = {}) {
	const root = opts.keepRoot ?? mkdtempSync(join(tmpdir(), "namzu-e2e-"));
	const dirs = {
		root,
		project: join(root, "project"),
		home: join(root, "namzu"),
		osHome: join(root, "os-home"),
		userData: join(root, "userdata"),
		shots: join(root, "shots"),
	};
	for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
	mkdirSync(join(dirs.project, ".git"), { recursive: true });
	writeFileSync(
		join(dirs.project, "namzu.config.json"),
		JSON.stringify({ sandbox: { enabled: false } }),
	);
	for (const [name, body] of Object.entries(opts.files ?? {})) {
		mkdirSync(dirname(join(dirs.project, name)), { recursive: true });
		writeFileSync(join(dirs.project, name), body);
	}
	if (!existsSync(join(dirs.home, "preferences.json"))) {
		writeFileSync(
			join(dirs.home, "preferences.json"),
			JSON.stringify({
				version: 3,
				providers: [{ id: "openai", model: opts.model ?? "gpt-e2e-1" }],
				subagents: { active: [] },
			}),
		);
	}
	const model = await startFakeModel(opts.rules ?? [], { models: opts.models });
	const world = {
		...dirs,
		model,
		app: null,
		page: null,
		cleanup: null,
		pathPrefix: opts.pathPrefix,
		env: opts.env,
		noKey: opts.noKey === true,
	};
	await opts.seed?.(world);
	return world;
}

export async function launch(world) {
	const appDir = freezeApp(world.root);
	const env = {};
	for (const [k, v] of Object.entries(process.env))
		if (INHERIT.test(k) && v !== undefined) env[k] = v;
	// Programs the flow wants found first on PATH (a stand-in for an installed engine CLI).
	if (world.pathPrefix) env.PATH = `${world.pathPrefix}:${env.PATH ?? ""}`;
	// Nothing reaches the real npm registry: the engine update check asks a dead loopback port unless a flow serves one.
	env.NAMZU_ENGINE_REGISTRY = "http://127.0.0.1:9";
	Object.assign(env, world.env ?? {});
	Object.assign(env, {
		HOME: world.osHome,
		USERPROFILE: world.osHome,
		XDG_CONFIG_HOME: join(world.osHome, ".config"),
		NAMZU_HOME: world.home,
		NAMZU_DESKTOP_CLI: join(here, "cli-entry.mjs"),
		NAMZU_E2E_MODEL_URL: world.model.url,
	});
	// A first-timer has no provider: nothing in the environment names a key.
	if (!world.noKey) env.OPENAI_API_KEY = "e2e-not-a-secret";
	else {
		// Under WSL the CLI also reads the sign-ins of the paired Windows account.
		// A first-timer has none, and the owner's must never decide what a test sees.
		delete env.WSL_DISTRO_NAME;
		delete env.WSL_INTEROP;
	}
	const app = await _electron.launch({
		executablePath: require("electron"),
		args: [appDir, `--user-data-dir=${world.userData}`, "--no-sandbox"],
		env,
	});
	world.app = app;
	await app.evaluate(({ dialog }, project) => {
		globalThis.__e2eDialog = { open: [project], box: 1, boxes: [] };
		dialog.showOpenDialog = async () => ({
			canceled: false,
			filePaths: globalThis.__e2eDialog.open,
		});
		dialog.showMessageBox = async (...args) => {
			const options = args.at(-1);
			globalThis.__e2eDialog.boxes.push({
				title: options.title,
				message: options.message,
			});
			return { response: globalThis.__e2eDialog.box, checkboxChecked: false };
		};
	}, world.project);
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => {
		for (const w of BrowserWindow.getAllWindows()) w.setSize(1280, 820);
	});
	await page.waitForLoadState("domcontentloaded");
	world.page = page;
	world.faults = [];
	page.on("pageerror", (e) => world.faults.push(e.message));
	return { app, page };
}

/**
 * Make the frozen copy record every frame it paints (window.__frames), from before the bundle.
 * Call with the app closed and before the launch to measure; the file lives only in the copy.
 */
export function instrumentFrames(world) {
	const renderer = join(freezeApp(world.root), "dist/renderer");
	cpSync(join(here, "frame-probe.js"), join(renderer, "frame-probe.js"));
	const index = join(renderer, "index.html");
	const html = readFileSync(index, "utf8");
	if (!html.includes("frame-probe.js"))
		writeFileSync(
			index,
			html.replace("<title>", '<script src="./frame-probe.js"></script><title>'),
		);
}

/**
 * Let the page read terminal screens (the terminals draw to a canvas, so there is no text to find).
 * The flag is read when the first terminal is made, so the page is loaded again after it is set.
 */
export async function enableTerminalDebug(world) {
	await world.page.evaluate(() => localStorage.setItem("namzu.terminal.debug", "1"));
	await world.page.reload();
	await world.page.waitForLoadState("domcontentloaded");
}

export async function relaunch(world) {
	await world.app?.close().catch(() => undefined);
	return launch(world);
}

export async function shoot(world, name) {
	try {
		await world.page?.screenshot({ path: join(world.shots, `${name}.png`) });
	} catch {}
}

export async function dispose(world, { failed = false } = {}) {
	if (failed) await shoot(world, "failure");
	await world.app?.close().catch(() => undefined);
	await world.model?.close().catch(() => undefined);
	if (failed) console.error(`e2e artifacts kept: ${world.root}`);
	else rmSync(world.root, { recursive: true, force: true });
}

/** Open the stubbed project through the real "Add new project" menu. */
export async function openProject(world) {
	const { page } = world;
	const welcome = page.getByRole("button", {
		name: "Add new project",
		exact: true,
	});
	await expect(welcome.first()).toBeVisible({ timeout: 30000 });
	await welcome.last().click();
	await page.getByRole("menuitem", { name: "Use an existing folder" }).click();
	// The fixture's namzu.config.json carries sandbox settings, so the in-app consent
	// asks "Trust this folder?" before the project opens; the user must confirm it.
	const consent = page.getByRole("dialog", { name: "Trust this folder?" });
	await expect(consent).toBeVisible({ timeout: 30000 });
	await consent.getByRole("button", { name: "Trust and open" }).click();
	await expect(
		page.getByRole("textbox", { name: "Message Namzu" }),
	).toBeVisible({ timeout: 60000 });
}

export async function send(world, text) {
	const box = world.page.getByRole("textbox", { name: "Message Namzu" });
	await box.fill(text);
	await world.page.getByRole("button", { name: "Send message" }).click();
}

/** Answer the next native message boxes with this button index (1 = the affirmative one). */
export const answerDialogs = (world, index) =>
	world.app.evaluate((_e, i) => {
		globalThis.__e2eDialog.box = i;
	}, index);
export const dialogsSeen = (world) =>
	world.app.evaluate(() => globalThis.__e2eDialog.boxes);
