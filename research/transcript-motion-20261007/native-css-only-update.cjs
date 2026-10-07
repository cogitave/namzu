"use strict";

// Reviewed style-only delivery. No reload, restart, host mutation, prompt,
// draft, navigation, focus, pointer movement, or conversation-body reads.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const hashes = {
	oldHtml: "c06639f390747304431a77a7346e1c3b7da3aafc27c87e3556b18dcdd98603fe",
	newHtml: "1061eea2b88f9f27f4ca73c0f700956cc08d1e26a2560068b4e5b10dd2d520f8",
	oldCss: "6102a3d7ea7a48df0be9499444915dc206decb999ce52c03e6411ecc5d363f52",
	newCss: "c2f6d205222fb5974d71a6b0edddb146ceecccb3db8e1150e6c95b0c24ae3431",
	js: "e40a9e971645ea47485efc375faac79013516aaee361533bba4a9c67b3dfdb60",
};
const oldCss = "index-G0YslIQe.css", newCss = "index-0HJrTCjy.css";
const oldJs = "index-TyqQe7z-.js", newJs = "index-BOLUfcPf.js";
const read = file => {
	const stat = fs.lstatSync(file);
	assert(stat.isFile() && !stat.isSymbolicLink() && stat.size < 8 * 1024 * 1024);
	return fs.readFileSync(file);
};
const tree = root => {
	const result = {};
	const walk = relative => {
		for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
			const name = path.join(relative, entry.name);
			assert(!entry.isSymbolicLink(), "Payload symlinks are not permitted.");
			if (entry.isDirectory()) walk(name);
			else result[name.replaceAll("\\", "/")] = sha(read(path.join(root, name)));
		}
	};
	walk("");
	return result;
};

(async () => {
	assert.equal(process.platform, "win32");
	assert.equal(process.argv.length, 3);
	assert(["--apply-reviewed-css", "--verify-applied-css"].includes(process.argv[2]));
	const verifyOnly = process.argv[2] === "--verify-applied-css";
	const dev = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
	const launchBytes = read(path.join(dev, "launch.json"));
	const config = JSON.parse(launchBytes);
	const pidBytes = read(path.join(dev, "desktop.pid"));
	const pid = Number(pidBytes.toString().trim());
	assert.equal(pid, 35180, "Only the reviewed existing process is eligible.");
	process.kill(pid, 0);
	const built = path.resolve(__dirname, "../../packages/desktop/dist");
	const installed = path.join(config.app, "dist");
	const before = tree(installed), source = tree(built);
	assert.equal(Object.keys(before).length, verifyOnly ? 732 : 730);
	assert.equal(Object.keys(source).length, 730);
	assert.equal(before["renderer/index.html"], verifyOnly ? hashes.newHtml : hashes.oldHtml);
	assert.equal(source["renderer/index.html"], hashes.newHtml);
	assert.equal(before[`renderer/assets/${oldCss}`], hashes.oldCss);
	assert.equal(source[`renderer/assets/${newCss}`], hashes.newCss);
	assert.equal(before[`renderer/assets/${oldJs}`], hashes.js);
	assert.equal(source[`renderer/assets/${newJs}`], hashes.js);
	for (const [name, hash] of Object.entries(before)) {
		if (["renderer/index.html", `renderer/assets/${oldCss}`, `renderer/assets/${oldJs}`].includes(name)) continue;
		assert.equal(source[name], hash, `Executable or other payload changed: ${name}`);
	}
	const oldHtml = read(path.join(installed, "renderer/index.html"));
	const newHtml = read(path.join(built, "renderer/index.html"));
	assert.equal(verifyOnly ? oldHtml.toString() : oldHtml.toString().replace(oldCss, newCss).replace(oldJs, newJs), newHtml.toString());
	const port = Number(read(path.join(process.env.APPDATA, "Namzu", "DevToolsActivePort")).toString().split(/\r?\n/)[0]);
	assert(Number.isInteger(port) && port > 0 && port < 65536);
	const { chromium } = require(path.join(dev, "runtime/packages/p39"));
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const directory = path.join(dev, `transcript-css-private-${crypto.randomUUID()}`);
	fs.mkdirSync(directory);
	const receipt = { schema: "namzu.native-css-only-delivery.v1", at: new Date().toISOString(), helperSha256: sha(read(__filename)), nativePid: pid, verifyOnly, restarts: 0, reloads: 0, providerRequests: 0, hostMutations: 0, bodyReads: 0, inputActions: 0, oldAssetsRetained: true, passed: false };
	let page, cdp, forcedNode;
	try {
		const pages = browser.contexts().flatMap(context => context.pages()).filter(item => item.url() === new URL(config.url).href);
		assert.equal(pages.length, 1);
		page = pages[0];
		const preflight = await page.evaluate(async oldCss => {
			if (Object.hasOwn(window, "__namzuReviewedCssProof")) throw new Error("A style proof already owns this view.");
			const workspace = await window.namzu.workspace();
			const visit = node => !node ? [] : node.kind === "group" ? [node] : [...visit(node.first), ...visit(node.second)];
			const win = workspace.layout.windows.find(item => item.id === workspace.windowId);
			const owner = visit(win?.root).find(item => item.id === win.focusedGroupId);
			const pane = [...document.querySelectorAll("[data-workspace-group]")].find(item => item.dataset.workspaceGroup === owner?.id);
			const transcript = pane?.querySelector(".normal-transcript");
			if (!transcript || !owner?.activeTabId) throw new Error("Ordinary owner unavailable.");
			const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
			if (links.length !== 1 || !links[0].href.endsWith(`/assets/${oldCss}`)) throw new Error("Owned stylesheet changed.");
			const editors = [...pane.querySelectorAll('textarea[aria-label="Message Namzu"]')].filter(item => item.checkVisibility({ visibilityProperty: true }));
			if (!editors.length) throw new Error("Visible composer is unavailable.");
			if (editors.some(item => item.value.length)) throw new Error("Existing human draft is not empty.");
			const focused = document.activeElement;
			if (focused?.checkVisibility({ visibilityProperty: true }) && focused.matches('textarea, input[type="text"], input[type="search"], [contenteditable="true"]') && (focused.value?.length || focused.isContentEditable && focused.textContent?.length)) throw new Error("Focused human input is not empty.");
			if (pane.querySelector("output.working[data-transcript-phase]")) throw new Error("Current turn is live.");
			let interactions = 0, revisions = 0;
			const onInput = () => { interactions++; };
			const observer = new MutationObserver(() => { revisions++; });
			const scroller = pane.querySelector(".transcript");
			if (!scroller) throw new Error("Transcript scroller unavailable.");
			const rect = scroller.getBoundingClientRect();
			const anchor = [...transcript.querySelectorAll(".message, .reasoning, .tool-trigger, .activity-trigger")].find(item => !item.closest('[inert], [aria-hidden="true"]') && item.getClientRects().length && item.getBoundingClientRect().bottom > rect.top && item.getBoundingClientRect().top < rect.bottom);
			if (!anchor) throw new Error("Reader anchor unavailable.");
			const saved = { owner, pane, transcript, link: links[0], originalHref: links[0].href, scroller, anchor, anchorOffset: anchor.getBoundingClientRect().top - rect.top, layout: JSON.stringify(workspace.layout), getInteractions: () => interactions, getRevisions: () => revisions, observer, onInput };
			Object.defineProperty(window, "__namzuReviewedCssProof", { value: saved, configurable: true });
			for (const type of ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "input"]) document.addEventListener(type, onInput, true);
			observer.observe(transcript, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-transcript-phase"] });
			return { editorCount: editors.length, editorCharacters: 0, anchorOffset: saved.anchorOffset, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, layoutShaInput: saved.layout };
		}, verifyOnly ? newCss : oldCss);
		receipt.preflight = { ...preflight, layoutSha256: sha(preflight.layoutShaInput) };
		delete receipt.preflight.layoutShaInput;
		// New assets are immutable additions; the old payload remains a rollback.
		for (const name of verifyOnly ? [] : [newCss, newJs]) {
			const destination = path.join(installed, "renderer/assets", name);
			assert(!fs.existsSync(destination));
			const bytes = read(path.join(built, "renderer/assets", name));
			assert.equal(sha(bytes), name === newCss ? hashes.newCss : hashes.js);
			fs.writeFileSync(destination, bytes, { flag: "wx" });
		}
		if (!verifyOnly) {
			fs.writeFileSync(path.join(directory, "index.before.html"), oldHtml, { flag: "wx" });
			const temporary = path.join(installed, `renderer/index.css-update-${crypto.randomUUID()}.tmp`);
			fs.writeFileSync(temporary, newHtml, { flag: "wx" });
			assert.equal(sha(read(path.join(installed, "renderer/index.html"))), hashes.oldHtml);
			fs.renameSync(temporary, path.join(installed, "renderer/index.html"));
		}
		receipt.persistentAssetsApplied = true;
		const delivery = verifyOnly ? await page.evaluate(newCss => {
			const saved = window.__namzuReviewedCssProof;
			return { parsed: Boolean(saved.link.sheet?.cssRules.length), hrefIsNew: saved.link.href.endsWith(`/assets/${newCss}`), oneTimeReaderCorrectionPx: 0, anchorOffset: saved.anchorOffset, userInteractions: saved.getInteractions(), styleAssignment: false };
		}, newCss) : await page.evaluate(async newCss => {
			const saved = window.__namzuReviewedCssProof;
			const sameOwner = async () => JSON.stringify((await window.namzu.workspace()).layout) === saved.layout && saved.pane.isConnected;
			if (saved.getInteractions() || saved.getRevisions() || !await sameOwner()) throw new Error("Human activity changed before style swap.");
			const staging = document.createElement("link");
			staging.rel = "stylesheet"; staging.crossOrigin = "anonymous"; staging.media = "not all";
			staging.href = new URL(`./assets/${newCss}`, document.URL).href;
			const loaded = new Promise((resolve, reject) => { staging.onload = resolve; staging.onerror = () => reject(new Error("Staged CSS load failed.")); });
			saved.link.after(staging);
			try {
				await loaded;
				if (!staging.sheet || !staging.sheet.cssRules.length) throw new Error("Staged CSS was not parsed.");
				if (saved.getInteractions() || saved.getRevisions() || !await sameOwner() || !saved.link.isConnected || saved.link.href !== saved.originalHref) throw new Error("Owned view changed before stylesheet assignment.");
				const applied = new Promise((resolve, reject) => { saved.link.onload = resolve; saved.link.onerror = () => reject(new Error("Owned CSS load failed.")); });
				saved.link.href = staging.href;
				await applied;
				await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
				if (saved.getInteractions() || saved.getRevisions() || !await sameOwner()) throw new Error("Human activity changed during style assignment.");
				// Correct only the one-time delivery's height change, before hover tests.
				const delta = saved.anchor.getBoundingClientRect().top - saved.scroller.getBoundingClientRect().top - saved.anchorOffset;
				if (delta) saved.scroller.scrollTop += delta;
				await new Promise(resolve => requestAnimationFrame(resolve));
				return { parsed: true, hrefIsNew: saved.link.href.endsWith(`/assets/${newCss}`), oneTimeReaderCorrectionPx: delta, anchorOffset: saved.anchor.getBoundingClientRect().top - saved.scroller.getBoundingClientRect().top, userInteractions: saved.getInteractions() };
			} finally { staging.remove(); saved.link.onload = null; saved.link.onerror = null; }
		}, newCss);
		receipt.liveDelivery = delivery;
		assert(delivery.parsed && delivery.hrefIsNew);
		const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
		assert(Math.abs(delivery.anchorOffset - preflight.anchorOffset) <= 1 / devicePixelRatio, "One-time delivery reader correction exceeds one native scroll pixel.");
		const target = await page.evaluate(() => {
			const saved = window.__namzuReviewedCssProof;
			const candidates = [...saved.transcript.querySelectorAll(".message-time")];
			const clock = candidates.find(item => {
				const row = item.closest(".message, .reasoning, .tool, .activity-trigger");
				const rect = item.getBoundingClientRect(), reader = saved.scroller.getBoundingClientRect();
				return row?.isConnected && row.classList.contains("message") && !row.closest('[data-slot="collapsible-panel"], [inert], [aria-hidden="true"]') && !row.matches(":hover") && item.getClientRects().length && rect.top >= Math.max(0, reader.top) && rect.bottom <= Math.min(innerHeight, reader.bottom) && getComputedStyle(item).opacity === "0";
			});
			if (!clock) throw new Error("No unhovered rendered clock available.");
			const row = clock.closest(".message, .reasoning, .tool, .activity-trigger");
			const index = [...saved.transcript.querySelectorAll(".message-time")].indexOf(clock);
			saved.clock = clock; saved.row = row;
			return { clockIndex: index, kind: row.classList.contains("message") ? "message" : "action-or-work", visibleInViewport: clock.getBoundingClientRect().top >= 0 && clock.getBoundingClientRect().bottom <= innerHeight };
		});
		assert(target.visibleInViewport);
		const measure = () => page.evaluate(async () => {
			const saved = window.__namzuReviewedCssProof;
			if (!saved.row.isConnected || !saved.pane.isConnected || saved.getInteractions() || saved.getRevisions() || JSON.stringify((await window.namzu.workspace()).layout) !== saved.layout) throw new Error("Existing owner changed during native hover proof.");
			const rect = node => {
				if (!node) return null;
				const r = node.getBoundingClientRect();
				return { x: r.x, y: r.y, width: r.width, height: r.height };
			};
			return { geometry: { clock: rect(saved.clock), row: rect(saved.row), parent: rect(saved.row.parentElement), next: rect(saved.row.nextElementSibling), composer: rect(saved.pane.querySelector(".composer")), chevron: rect(saved.row.querySelector(".disclosure-chevron")), scrollTop: saved.scroller.scrollTop, scrollHeight: saved.scroller.scrollHeight, clientHeight: saved.scroller.clientHeight }, opacity: getComputedStyle(saved.clock).opacity, transitionProperty: getComputedStyle(saved.clock).transitionProperty, interactions: saved.getInteractions(), contentRevisions: saved.getRevisions() };
		});
		const rest = await measure();
		assert.equal(rest.transitionProperty, "opacity");
		assert.equal(rest.opacity, "0");
		cdp = await page.context().newCDPSession(page);
		await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
		const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
		const scoped = `[data-workspace-group="${await page.evaluate(() => window.__namzuReviewedCssProof.owner.id)}"] .normal-transcript .message-time`;
		const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: scoped });
		const { node } = await cdp.send("DOM.describeNode", { nodeId: nodeIds[target.clockIndex], depth: 0 });
		const handle = await page.evaluateHandle(() => window.__namzuReviewedCssProof.row);
		const session = await cdp.send("Runtime.evaluate", { expression: "window.__namzuReviewedCssProof.row" });
		forcedNode = (await cdp.send("DOM.requestNode", { objectId: session.result.objectId })).nodeId;
		await handle.dispose();
		assert(forcedNode && node.nodeId);
		await cdp.send("CSS.forcePseudoState", { nodeId: forcedNode, forcedPseudoClasses: ["hover"] });
		const samples = [];
		for (const fraction of [0, 0.5, 1]) {
			const animation = await page.evaluate(fraction => {
				const clock = window.__namzuReviewedCssProof.clock;
				getComputedStyle(clock).opacity;
				const transition = clock.getAnimations().find(item => item.transitionProperty === "opacity");
				// Finishing before this observation is not a failure on a loaded host.
				// Deterministic intermediate timing is established by the isolated proof.
				if (!transition) return { observedTransition: false, limit: "Transition already settled before sampling." };
				transition.pause(); transition.currentTime = 160 * fraction;
				return { observedTransition: true, type: transition.constructor.name, duration: transition.effect.getTiming().duration, currentTime: transition.currentTime };
			}, fraction);
			const sample = await measure();
			assert.deepEqual(sample.geometry, rest.geometry);
			assert.equal(sample.interactions, 0);
			assert.equal(sample.contentRevisions, 0);
			 samples.push({ fraction, animation, ...sample });
		}
		assert.equal(samples.at(-1).opacity, "1");
		await cdp.send("CSS.forcePseudoState", { nodeId: forcedNode, forcedPseudoClasses: [] }); forcedNode = undefined;
		await page.evaluate(async () => {
			const animations = window.__namzuReviewedCssProof.clock.getAnimations();
			for (const item of animations) item.finish();
			await new Promise(resolve => requestAnimationFrame(resolve));
		});
		const afterHover = await measure();
		assert.deepEqual(afterHover.geometry, rest.geometry);
		assert.equal(afterHover.opacity, "0");
		assert.equal(afterHover.interactions, 0);
		assert.equal(afterHover.contentRevisions, 0);
		const finalLayout = await page.evaluate(async () => JSON.stringify((await window.namzu.workspace()).layout));
		assert.equal(sha(finalLayout), receipt.preflight.layoutSha256);
		const after = tree(installed);
		for (const [name, hash] of Object.entries(before)) if (name !== "renderer/index.html") assert.equal(after[name], hash);
		assert.equal(after["renderer/index.html"], hashes.newHtml);
		assert.equal(after[`renderer/assets/${newCss}`], hashes.newCss);
		assert.equal(after[`renderer/assets/${newJs}`], hashes.js);
		assert.equal(sha(read(path.join(dev, "launch.json"))), sha(launchBytes));
		assert.equal(sha(read(path.join(dev, "desktop.pid"))), sha(pidBytes));
		process.kill(pid, 0);
		Object.assign(receipt, { passed: true, payloadFilesUnchanged: verifyOnly ? 732 : 729, identicalExecutableBytes: true, persistentHtmlSha256: hashes.newHtml, cssSha256: hashes.newCss, hover: { method: "native CDP forced CSS hover; no human pointer movement", target, rest, samples, afterHover }, ownerLayoutUnchanged: true, sameNativePid: true });
	} catch (error) {
		receipt.error = { name: error.name, message: error.message };
		process.exitCode = 1;
	} finally {
		if (forcedNode && cdp) await cdp.send("CSS.forcePseudoState", { nodeId: forcedNode, forcedPseudoClasses: [] }).catch(() => {});
		if (page) await page.evaluate(() => {
			const saved = window.__namzuReviewedCssProof;
			if (!saved) return;
			saved.observer.disconnect();
			for (const type of ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "input"]) document.removeEventListener(type, saved.onInput, true);
			for (const item of saved.clock?.getAnimations() ?? []) if (item.playState === "paused") item.finish();
			delete window.__namzuReviewedCssProof;
		}).catch(() => {});
		if (cdp) await cdp.detach().catch(() => {});
		await browser.close();
		const file = path.join(directory, "receipt.json");
		fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
		console.log(JSON.stringify({ passed: receipt.passed, persistentAssetsApplied: receipt.persistentAssetsApplied ?? false, restarts: 0, reloads: 0, providerRequests: 0, privateReceipt: file, error: receipt.error ?? null }));
	}
})().catch(error => { console.error(JSON.stringify({ preflightFailed: true, error: error.message })); process.exitCode = 1; });
