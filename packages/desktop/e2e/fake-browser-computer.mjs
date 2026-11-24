// A computer-use host whose only window is a browser (Brave on a SharePoint admin page), for e2e and live
// model runs. Nothing reaches a display: a picture is drawn, every click is recorded in a file named by
// NAMZU_E2E_BROWSER_LOG (when set), and `listWindows` answers the one window. See fake-browser-computer-hooks.mjs.
import { appendFileSync } from "node:fs";
import { screenPng } from "./computer-stub.mjs";

const win = {
	id: "0x4a00007",
	title: "Active sites - SharePoint admin center - Brave",
	app: process.env.NAMZU_E2E_BROWSER_APP ?? "brave-browser",
	pid: 4242,
	bounds: { x: 0, y: 0, width: 640, height: 400 },
	focused: true,
	minimized: false,
};
const log = (entry) => {
	if (process.env.NAMZU_E2E_BROWSER_LOG)
		appendFileSync(
			process.env.NAMZU_E2E_BROWSER_LOG,
			`${JSON.stringify(entry)}\n`,
		);
};

export class SubprocessComputerUseHost {
	id = "e2e-browser-host";
	capabilities = {
		displayServer: "x11",
		screenshot: true,
		mouse: true,
		keyboard: true,
		cursorPosition: false,
		clipboard: false,
		windows: true,
		windowCapture: true,
	};
	async initialize() {}
	async dispose() {}
	async getDisplayGeometry() {
		return { width: 640, height: 400, scaleFactor: 1 };
	}
	async execute(action) {
		if (action.type === "screenshot")
			return {
				type: "screenshot",
				result: {
					data: screenPng(640, 400),
					mimeType: "image/png",
					width: 640,
					height: 400,
				},
			};
		log({ via: "execute", action });
		return { type: "ok" };
	}
	async listWindows() {
		return [win];
	}
	async focusWindow() {
		return { ok: true };
	}
	async captureWindow() {
		return {
			data: screenPng(640, 400),
			mimeType: "image/png",
			width: 640,
			height: 400,
			window: win,
			captureId: "cap-1",
		};
	}
	async executeWindow(captureId, action) {
		log({ via: "executeWindow", action });
		return { delivery: "delivered_unverified", retrySafety: "unsafe" };
	}
	beginTurn() {}
	endTurn() {}
}
