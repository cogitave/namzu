// Voice input end to end in real Electron: Chromium's fake capture device plays a recorded Turkish
// command into the microphone, and the flow checks that the composer's microphone, the one-time
// agreement, the listening engine and the send path turn it into a normal message that the scripted
// model answers. Screenshots land in research/voice-input-20261016/ and are looked at, not asserted.
//
// Opt-in, because it needs the ~1 GB of listening models already on disk:
//   NAMZU_LOCAL_LISTENING_MODELS  a folder holding the four pinned model files (symlinks are fine)
//   NAMZU_LOCAL_LISTENING_WAVS    a folder holding cmd02.wav (16 kHz mono PCM, "Bugünkü toplantılarımı listele.")
// Run: pnpm --filter @namzu/desktop build && xvfb-run -a node --test e2e/ux-voice-input.test.mjs
import assert from "node:assert/strict";
import { linkSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";
import { LISTENING_ASSETS, LISTENING_MODEL_REVISION } from "../dist/main/local-listening-assets.js";

const T = 90000;
const SHOTS = resolve(repoRoot, "research/voice-input-20261016");
const models = process.env.NAMZU_LOCAL_LISTENING_MODELS;
const wavs = process.env.NAMZU_LOCAL_LISTENING_WAVS;

/** The installed state the engine expects, made of hard links so nothing is copied or downloaded. */
function seedListening(userData) {
	const directory = join(userData, "local-listening");
	const target = join(directory, "models");
	mkdirSync(target, { recursive: true });
	let diskBytes = 0;
	for (const asset of LISTENING_ASSETS) {
		const source = realpathSync(join(models, asset.name));
		linkSync(source, join(target, asset.name));
		diskBytes += statSync(source).size;
	}
	writeFileSync(
		join(directory, "installation.json"),
		JSON.stringify({
			v: 1,
			modelRevision: LISTENING_MODEL_REVISION,
			diskBytes,
			installedAt: new Date().toISOString(),
			files: LISTENING_ASSETS.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
		}),
	);
}

async function setAppearance(w, value) {
	await w.page.evaluate((next) => {
		localStorage.setItem("namzu.appearance", next);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: next }));
	}, value);
	await expect(w.page.locator("html")).toHaveClass(value === "dark" ? /dark/ : /^(?!.*dark)/);
}

async function shot(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	await w.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test(
	"a spoken Turkish command becomes a message the model answers",
	{ timeout: 240000, skip: !models || !wavs ? "set NAMZU_LOCAL_LISTENING_MODELS and NAMZU_LOCAL_LISTENING_WAVS" : false },
	async () => {
		const w = await createWorld({
			rules: [
				{ match: /merhaba/i, steps: [{ text: "Merhaba, buradayım." }] },
				{ match: /toplant/i, steps: [{ text: "Bugün takviminde toplantı yok." }] },
			],
			// Chromium plays the file once into the default microphone, then silence.
			electronArgs: [
				"--use-fake-device-for-media-stream",
				`--use-file-for-fake-audio-capture=${join(wavs, "cmd02.wav")}%noloop`,
			],
			seed: (world) => seedListening(world.userData),
		});
		let failed = true;
		try {
			await launch(w);
			await openProject(w);
			// The microphone works in a conversation that exists, so a first typed message makes one.
			await send(w, "merhaba");
			await expect(w.page.getByText("Merhaba, buradayım.")).toBeVisible({ timeout: T });

			const mic = w.page.getByRole("button", { name: "Turn on voice input", exact: true });
			await expect(mic).toBeVisible({ timeout: T });
			await shot(w, "1-mic-off");
			await mic.click();

			const consent = w.page.getByRole("region", { name: "Turn on voice input?" });
			await expect(consent).toBeVisible({ timeout: T });
			await shot(w, "2-consent");
			await consent.getByRole("button", { name: "Turn on voice input", exact: true }).click();

			await expect(w.page.locator(".voice-listening")).toBeVisible({ timeout: T });
			await shot(w, "3-listening");

			// The recorded command arrives as the person's message and the scripted model answers it.
			await expect(w.page.getByText(/toplantılarımı listele/i).first()).toBeVisible({ timeout: T });
			await expect(w.page.getByText("Bugün takviminde toplantı yok.")).toBeVisible({ timeout: T });
			await shot(w, "4-sent-and-answered");

			await setAppearance(w, "light");
			await shot(w, "4-sent-and-answered-light");
			await setAppearance(w, "dark");

			await w.page.getByRole("button", { name: "Turn off voice input", exact: true }).click();
			await expect(w.page.locator(".voice-listening")).toBeHidden({ timeout: T });
			await shot(w, "5-mic-off-again");

			// The installed engine's card in Settings, Speech, in both themes.
			await w.page.getByRole("button", { name: "Settings", exact: true }).click();
			const sections = w.page.getByRole("navigation", { name: "Settings sections" });
			await expect(sections).toBeVisible({ timeout: T });
			await sections.getByRole("button", { name: "Speech", exact: true }).click();
			const card = w.page.getByRole("heading", { name: "Voice input", exact: true });
			await expect(card).toBeVisible({ timeout: T });
			await card.scrollIntoViewIfNeeded();
			await shot(w, "6-settings-dark");
			await setAppearance(w, "light");
			await shot(w, "6-settings-light");
			assert.deepEqual(w.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(w, { failed });
		}
	},
);
