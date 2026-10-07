"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
assert.equal(process.platform, "win32");
const root = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
const output = path.resolve(process.argv[2]);
assert(path.dirname(output) === root && !fs.existsSync(output));
const config = JSON.parse(fs.readFileSync(path.join(root, "launch.json")));
const pid = Number(fs.readFileSync(path.join(root, "desktop.pid"), "utf8"));
process.kill(pid, 0);
const { chromium } = require(path.join(root, "runtime/packages/p39"));
(async () => {
	const port = Number(
		fs
			.readFileSync(
				path.join(process.env.APPDATA, "Namzu", "DevToolsActivePort"),
				"utf8",
			)
			.split(/\r?\n/)[0],
	);
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	try {
		const page = browser
			.contexts()
			.flatMap((context) => context.pages())
			.find((page) => page.url() === new URL(config.url).href);
		assert(page);
		const states = await page.evaluate(async () => {
			const profiles = await window.namzu.pals();
			return Promise.all(
				profiles.map((profile) => window.namzu.palComputer(profile.id)),
			);
		});
		fs.writeFileSync(output, JSON.stringify({ pid, states }), { flag: "wx" });
		process.stdout.write(
			JSON.stringify({
				observed: true,
				states: states.map((state) => ({
					status: state.status,
					keys: Object.keys(state),
					requiresStop: state.requiresStop,
				})),
			}) + "\n",
		);
	} finally {
		await browser.close();
	}
	process.kill(pid, 0);
})().catch((error) => {
	process.stderr.write(error.name + "\n");
	process.exitCode = 1;
});
