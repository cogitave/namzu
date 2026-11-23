// A bare Electron main for the agent-tab relay flow: the real BrowserPaneHost and AgentPaneRelay from the
// built app, one window, nothing else (no engine, no renderer, no model). The test drives it through
// `app.evaluate` and reads what it did through `globalThis.__lab`.
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");
const { app, BrowserWindow, WebContentsView, session } = require("electron");

app.whenReady().then(async () => {
	const dist = process.env.LAB_DIST;
	const load = (file) => import(pathToFileURL(join(dist, "main", file)).href);
	const { BrowserPaneHost } = await load("browser-pane.js");
	const { AgentPaneRelay, RelayError } = await load("agent-pane-relay.js");
	const { shrinkImage } = await load("agent-pane-shrink.js");
	const folders = JSON.parse(process.env.LAB_WORK_FOLDERS ?? "{}");
	const window = new BrowserWindow({ width: 1100, height: 800, show: true });
	const host = new BrowserPaneHost({
		window,
		createView: (partition) =>
			new WebContentsView({
				webPreferences: {
					partition,
					nodeIntegration: false,
					contextIsolation: true,
					sandbox: true,
					webSecurity: true,
					allowRunningInsecureContent: false,
					safeDialogs: true,
				},
			}),
		sessionOf: (partition) => session.fromPartition(partition),
		workFolder: (id) => folders[id],
		caseless: false,
		cookieScope: () => "quit",
		send: () => undefined,
	});
	const relay = new AgentPaneRelay({ shrinkImage, preferredHost: () => host });
	relay.addHost(host);
	const events = [];
	const waiters = [];
	relay.onEvent((event) => {
		events.push(event);
		for (const waiter of [...waiters]) if (waiter.match(event)) waiter.done(event);
	});
	const lab = {
		host,
		relay,
		events,
		/** Runs a relay call and answers with its result or its typed error, never a thrown error. */
		async call(name, input) {
			try {
				return { ok: true, value: await relay[name](input) };
			} catch (error) {
				if (error instanceof RelayError) return { ok: false, code: error.code, message: error.message };
				return { ok: false, code: "other", message: String(error?.message ?? error) };
			}
		},
		/** Resolves with the first event, already seen or still to come, whose fields match. */
		next(fields, from = 0) {
			const match = (event) => Object.entries(fields).every(([key, value]) => event[key] === value);
			const seen = events.slice(from).find(match);
			if (seen) return Promise.resolve(seen);
			return new Promise((resolve) => {
				const waiter = {
					match,
					done: (event) => {
						waiters.splice(waiters.indexOf(waiter), 1);
						resolve(event);
					},
				};
				waiters.push(waiter);
			});
		},
	};
	globalThis.__lab = lab;
	await window.loadURL("about:blank");
	process.stdout.write("LAB READY\n");
});
