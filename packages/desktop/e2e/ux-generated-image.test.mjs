// An image the agent generates with generate_image shows as an image card under the reply: the
// picture itself, the prompt, and Open / Show in folder / Copy / Save a copy. The images service is
// a scripted local server; the main model is a scripted chat model that is not the plan's own, and the
// plan sign-in is a made-up file in the scratch home. Real Electron, real CLI host.
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test --test-concurrency=1 e2e/ux-generated-image.test.mjs
// Pictures: GENERATED_IMAGE_SHOTS=<dir> (default research/generated-image).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 90000;
const SHOTS = process.env.GENERATED_IMAGE_SHOTS ?? resolve(repoRoot, "research/generated-image");
mkdirSync(SHOTS, { recursive: true });
const shot = (w, name) => w.page.screenshot({ path: join(SHOTS, `${name}.png`) });

const crcTable = (() => {
	const t = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t.push(c >>> 0);
	}
	return t;
})();
const crc = (b) => {
	let c = 0xffffffff;
	for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
	const l = Buffer.alloc(4);
	l.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type), data]);
	const c = Buffer.alloc(4);
	c.writeUInt32BE(crc(body));
	return Buffer.concat([l, body, c]);
};
/** A real PNG: a sunrise gradient over a dark hill, so the card shows something recognisable. */
function picture(w = 320, h = 200) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const rows = [];
	for (let y = 0; y < h; y++) {
		const row = Buffer.alloc(1 + w * 3);
		for (let x = 0; x < w; x++) {
			const hill = y > h * 0.62 + Math.sin(x / 38) * 14;
			row[1 + x * 3] = hill ? 38 : Math.min(255, 255 - y * 0.6);
			row[2 + x * 3] = hill ? 70 : Math.min(255, 150 + x * 0.2 - y * 0.5);
			row[3 + x * 3] = hill ? 52 : Math.min(255, 90 + y * 0.9);
		}
		rows.push(row);
	}
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("a generated image shows as a card with the picture and its actions", { timeout: 280000 }, async () => {
	const requests = [];
	const images = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			requests.push({ url: req.url, body: JSON.parse(body || "{}") });
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ created: 1, data: [{ b64_json: picture().toString("base64") }] }));
		});
	});
	await new Promise((r) => images.listen(0, "127.0.0.1", r));
	const world = await createWorld({
		answerHistory: true,
		tabs: "hidden",
		seed: (w) => {
			// A made-up plan sign-in; no real credential is read or written anywhere.
			const part = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
			const token = `${part({ alg: "none" })}.${part({ exp: Math.floor(Date.now() / 1000) + 86400, "https://api.openai.com/auth": { ["chatgpt" + "_account_id"]: "acct-fake", ["chatgpt" + "_plan_type"]: "plus" } })}.sig`;
			mkdirSync(join(w.osHome, ".codex"), { recursive: true });
			writeFileSync(join(w.osHome, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: token, refresh_token: "fake", account_id: "acct-fake" } }));
			w.env = { NAMZU_E2E_IMAGES_URL: `http://127.0.0.1:${images.address().port}` };
		},
		rules: [
			{
				match: /paint me a fox/i,
				steps: [
					{ tool: "search_tools", args: { query: "generate_image" } },
					{ tool: "generate_image", args: { prompt: "a red fox on a hill at sunrise, soft watercolor" } },
					{ text: "Here is your fox at sunrise." },
				],
			},
		],
	});
	try {
		await launch(world);
		await openProject(world);
		const w = world;
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.setSize(1280, 820)));
		await w.app.evaluate(({ shell }) => {
			globalThis.__opened = [];
			shell.openPath = async (path) => {
				globalThis.__opened.push(["open", path]);
				return "";
			};
			shell.showItemInFolder = (path) => globalThis.__opened.push(["folder", path]);
		});
		await send(w, "paint me a fox");
		// The call sends the prompt out under the person's plan, so the first one is asked about.
		await expect(w.page.getByRole("heading", { name: "Allow Namzu to generate image?" })).toBeVisible({ timeout: T });
		await w.page.getByRole("button", { name: "Accept", exact: true }).click();
		await expect(w.page.getByText("Here is your fox at sunrise.")).toBeVisible({ timeout: T });
		await expect(w.page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: T });
		assert.equal(requests.length, 1);
		assert.equal(requests[0].url, "/backend-api/codex/images/generations");
		assert.equal(requests[0].body.model, "gpt-image-2");
		const card = w.page.locator("[data-output-card]");
		await expect(card).toHaveCount(1, { timeout: T });
		await expect(card).toContainText("Generated");
		await expect(card).toContainText("a red fox on a hill at sunrise, soft watercolor");
		const picture = card.locator("img[data-generated-image]");
		await expect(picture).toBeVisible({ timeout: T });
		await expect.poll(() => picture.evaluate((img) => img.complete && img.naturalWidth), { timeout: T }).toBe(320);
		await card.hover();
		await w.page.waitForTimeout(1500);
		for (const name of [/Show .* in its folder/, /Copy the picture/, /Save a copy of/, /^Open .* with the app for this kind of file$/])
			await expect(card.getByRole("button", { name })).toBeVisible();
		await card.getByRole("button", { name: /Show .* in its folder/ }).click();
		await card.getByRole("button", { name: /^Open .* with the app for this kind of file$/ }).click();
		await expect.poll(() => w.app.evaluate(() => globalThis.__opened.length), { timeout: T }).toBe(2);
		const opened = await w.app.evaluate(() => globalThis.__opened);
		for (const entry of opened) assert.match(entry[1], /generated_images[\\/].+[\\/].+\.png$/);
		await shot(w, "card-wide");
		// Layout audit: the card fits the column, the picture fits the card, nothing scrolls sideways.
		const audit = await w.page.evaluate(() => {
			const c = document.querySelector("[data-output-card]")?.getBoundingClientRect();
			const img = document.querySelector("img[data-generated-image]")?.getBoundingClientRect();
			return {
				pictureInside: Boolean(c && img && img.left >= c.left - 1 && img.right <= c.right + 1),
				pictureHeight: img?.height,
				pageScroll: document.documentElement.scrollWidth > window.innerWidth,
			};
		});
		assert.equal(audit.pictureInside, true);
		assert.equal(audit.pageScroll, false);
		assert.ok(audit.pictureHeight > 40, "the picture has a visible height");
		await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.setSize(720, 820)));
		await w.page.waitForTimeout(800);
		const narrow = await w.page.evaluate(() => ({ pageScroll: document.documentElement.scrollWidth > window.innerWidth, over: document.querySelector("[data-output-card]").getBoundingClientRect().right > window.innerWidth + 1 }));
		assert.equal(narrow.pageScroll, false);
		assert.equal(narrow.over, false);
		await shot(w, "card-narrow");
	} finally {
		await dispose(world);
		await new Promise((r) => images.close(r));
	}
});
