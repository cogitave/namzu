// What a person reads when a provider answers badly, and Settings > Models when a key is checked.
// Real Electron app, real CLI host, scripted provider server. No network, no paid model.
// Run: pnpm --filter @namzu/desktop build && cd packages/desktop && xvfb-run -a node --test e2e/ux-provider-replies.test.mjs
// Pictures go to research/hygiene-20261010/provider-replies/.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createWorld, dispose, expect, launch, openProject, repoRoot, send } from "./harness.mjs";

const T = 60000;
const SHOTS = resolve(repoRoot, "research/hygiene-20261010/provider-replies");
const PROVIDER_NAME = "OpenAI";
const KEY = "sk-e2e-pasted-key-1234567890";

function flow(name, options, body) {
	test(name, { timeout: 240000 }, async () => {
		const world = await createWorld(options);
		let failed = true;
		try {
			await launch(world);
			await body(world);
			assert.deepEqual(world.faults, [], "the renderer raised no uncaught errors");
			failed = false;
		} finally {
			await dispose(world, { failed });
		}
	});
}

async function size(w, width, height) {
	await w.app.evaluate(
		({ BrowserWindow }, [x, y]) => {
			for (const win of BrowserWindow.getAllWindows()) win.setSize(x, y);
		},
		[width, height],
	);
}
async function theme(w, mode) {
	await w.page.evaluate((value) => {
		localStorage.setItem("namzu.appearance", value);
		window.dispatchEvent(new StorageEvent("storage", { key: "namzu.appearance", newValue: value }));
	}, mode);
	if (mode === "light") await expect(w.page.locator("html")).not.toHaveClass(/dark/);
	else await expect(w.page.locator("html")).toHaveClass(/dark/);
}
/** The picture at 900 and 1280 px, in the dark theme and the light one. */
async function shots(w, name) {
	mkdirSync(SHOTS, { recursive: true });
	for (const width of [900, 1280]) {
		await size(w, width, 820);
		for (const mode of ["dark", "light"]) {
			await theme(w, mode);
			await w.page.screenshot({ path: join(SHOTS, `${name}-${width}-${mode}.png`) });
		}
	}
	await theme(w, "dark");
	await size(w, 1280, 820);
}
const box = (w) => w.page.getByRole("textbox", { name: "Message Namzu" });
async function sendText(w, text) {
	await box(w).fill(text);
	await w.page.getByRole("button", { name: "Send message" }).click();
}
async function openModels(w) {
	await w.page.getByRole("button", { name: "Settings", exact: true }).click();
	await w.page
		.getByRole("navigation", { name: "Settings sections" })
		.getByRole("button", { name: "Models", exact: true })
		.click();
	await expect(w.page.getByRole("heading", { level: 1, name: "Models", exact: true })).toBeVisible({
		timeout: T,
	});
}
const providerRow = (w) =>
	w.page.locator(".models-row").filter({
		has: w.page.getByRole("heading", { name: PROVIDER_NAME, exact: true }),
	});
const JARGON =
	/HTTP|\b[45]\d\d\b|receipt|unresolved|budget|reservation|<html|\{"error"|Error invoking|insufficient_quota|proj_[a-z0-9]+/i;

const json = (status, message, extra = {}) => ({
	status,
	contentType: "application/json",
	body: JSON.stringify({ error: { message, ...extra } }),
});

function headlineFlow(name, step, headline, buttons, detailsPattern, shotName) {
	flow(
		name,
		{ rules: [{ match: /go wrong/i, steps: [step] }] },
		async (w) => {
			await openProject(w);
			await sendText(w, "please go wrong");
			const region = w.page.locator(".turn-recovery");
			await expect(region.getByText(headline, { exact: true })).toBeVisible({ timeout: T });
			for (const label of buttons)
				await expect(region.getByRole("button", { name: label, exact: true })).toBeVisible();
			const visible = (await region.innerText()).replace(/Details[\s\S]*$/, "");
			assert.doesNotMatch(visible, JARGON, "the headline carries no code, markup or accounting words");
			await region.getByRole("button", { name: "Details", exact: true }).click();
			const details = await region.locator(".turn-recovery-details-text").innerText();
			assert.match(details, detailsPattern);
			assert.doesNotMatch(details, /usage/i, "no reply arrived, so Details carry no usage line");
			assert.doesNotMatch(details, /[{}]|<\/?\w+>/, "labelled fields only, no JSON or markup");
			assert.doesNotMatch(details, /unresolved|reservation|(\b\d{3})\s+\1\b|\(no body\)/i);
			await shots(w, shotName);
		},
	);
}

headlineFlow(
	"a model the account cannot use does not blame the key",
	json(403, "Project proj_abc123 does not have access to model gpt-5", { code: "model_not_found" }),
	"Your OpenAI account can’t use gpt-5. Choose another model.",
	["Open model settings"],
	new RegExp(`${PROVIDER_NAME}: access was refused`),
	"403-model-access",
);

headlineFlow(
	"an account out of credit says so instead of asking for a minute",
	json(429, "You exceeded your current quota, please check your plan and billing details.", {
		type: "insufficient_quota",
		code: "insufficient_quota",
	}),
	"Your OpenAI account is out of credit. Add credit in your OpenAI billing page, then send again.",
	["Open model settings"],
	/exceeded your current quota/,
	"429-quota",
);

headlineFlow(
	"a request the provider times out on says it took too long",
	json(408, "Request timed out."),
	"OpenAI took too long to answer. Try again.",
	["Retry"],
	new RegExp(`${PROVIDER_NAME}: could not reach the provider`),
	"408-timeout",
);

headlineFlow(
	"a model that is not offered to the account is named as missing",
	json(404, "The model `gpt-9` does not exist or you do not have access to it.", {
		code: "model_not_found",
	}),
	"OpenAI doesn’t offer that model to your account. Choose another model.",
	["Open model settings"],
	new RegExp(`${PROVIDER_NAME}: the provider rejected the request as invalid`),
	"404-model-missing",
);

headlineFlow(
	"a message that is too large says so",
	{ status: 413, contentType: "text/html", body: "<html><body>413 Request Entity Too Large</body></html>" },
	"This message is too large for OpenAI. Shorten it or remove an attachment, then send again.",
	[],
	new RegExp(`${PROVIDER_NAME}: the provider rejected the request as invalid \\(413 Request Entity Too Large\\)`),
	"413-too-large",
);

headlineFlow(
	"a bad gateway page is summarised, never dumped",
	{
		status: 502,
		contentType: "text/html",
		body: "<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>cloudflare</center>Ray ID: 8f2a1b3c4d5e6f70</body></html>",
	},
	"OpenAI had a problem on its side. Your message is saved.",
	["Retry"],
	new RegExp(`${PROVIDER_NAME}: the provider failed to complete the request \\(502 Bad Gateway\\)\\nRequest ID: 8f2a1b3c4d5e6f70`),
	"502-bad-gateway",
);

headlineFlow(
	"an internal server error (500) is plain, with labelled Details and no usage line",
	json(500, "The server had an error while processing your request.", { type: "server_error" }),
	"OpenAI had a problem on its side. Your message is saved.",
	["Retry"],
	new RegExp(`${PROVIDER_NAME}: the provider failed to complete the request \\(500`),
	"500-server-error",
);

headlineFlow(
	"a service unavailable page (503) is summarised, with no usage line",
	{
		status: 503,
		contentType: "text/html",
		body: "<html><head><title>503 Service Unavailable</title></head><body><h1>503 Service Unavailable</h1></body></html>",
	},
	"OpenAI had a problem on its side. Your message is saved.",
	["Retry"],
	new RegExp(`${PROVIDER_NAME}: the provider failed to complete the request \\(503 Service Unavailable\\)`),
	"503-unavailable",
);

flow(
	"a saved key the provider turns down shows as rejected, and a quota or outage says what happened",
	{ noKey: true, rules: [] },
	async (w) => {
		await openProject(w);
		await openModels(w);
		// Unconnected rows say what to do.
		await expect(w.page.getByText("Add an API key to use OpenAI.")).toBeVisible({ timeout: T });
		await expect(w.page.getByText(/or from the Namzu tab/)).toHaveCount(0);
		await shots(w, "models-unconnected");

		await w.page.getByRole("button", { name: "Add an API key for OpenAI", exact: true }).click();
		// An empty field says why Save key is off.
		const save = w.page.getByRole("button", { name: "Save key" });
		await expect(save).toBeDisabled();
		await expect(w.page.getByText("Paste your API key to save it.")).toBeVisible();
		await expect(save).toHaveAttribute("title", "Paste your API key first.");

		w.model.answerListing(json(401, "Incorrect API key provided: sk-e2e***."));
		await w.page.getByLabel("OpenAI API key").fill(KEY);
		await save.click();
		const row = providerRow(w);
		await expect(row.getByText("Key not accepted")).toBeVisible({ timeout: T });
		await expect(row.getByText(/^Connected with/)).toHaveCount(0);
		await expect(row.getByText(new RegExp(`${PROVIDER_NAME} did not accept this key`))).toBeVisible();
		await shots(w, "models-key-rejected");

		const check = row.getByRole("button", { name: "Check the connection to OpenAI" });
		for (const [listing, text] of [
			[
				json(429, "You exceeded your current quota, please check your plan and billing details."),
				"OpenAI says this account is out of credit. Add credit with OpenAI, then check again.",
			],
			[
				json(429, "Rate limit reached for requests"),
				"OpenAI is busy right now. Check again in a minute.",
			],
			[
				{ status: 502, contentType: "text/html", body: "<html><body>502 Bad Gateway</body></html>" },
				"OpenAI had a problem on its side. Check again in a few minutes.",
			],
		]) {
			w.model.answerListing(listing);
			await check.click();
			await expect(row.getByText(text)).toBeVisible({ timeout: T });
			assert.doesNotMatch(await row.innerText(), /without sending a message|saved but not confirmed/);
		}
		await shots(w, "models-check-outage");

		// The provider accepts it again: the row is connected, not rejected.
		w.model.answerListing(undefined);
		await check.click();
		await expect(row.getByText("OpenAI accepted the key.")).toBeVisible({ timeout: T });
		await expect(row.getByText("Key not accepted")).toHaveCount(0);
		await expect(row.getByText("Connected with the key you saved")).toBeVisible();
	},
);

flow(
	"an environment key reads in plain words, with where it comes from behind a tooltip",
	{ rules: [] },
	async (w) => {
		await openProject(w);
		await openModels(w);
		const row = providerRow(w);
		const status = row.locator(".models-row-status");
		await expect(status).toHaveText("Connected with a key from your computer’s settings", {
			timeout: T,
		});
		await expect(status).toHaveAttribute("title", /OPENAI_API_KEY/);
		await shots(w, "models-env-key");
	},
);

flow(
	"the model list says why it is empty, and Try again is a visible button",
	{ rules: [] },
	async (w) => {
		// The provider cannot list its models from the first request, so the answer never depends on timing.
		w.model.answerListing({
			status: 502,
			contentType: "text/html",
			body: "<html><body>502 Bad Gateway</body></html>",
		});
		await openProject(w);
		await expect(box(w)).toBeVisible({ timeout: T });
		await w.page.getByRole("button", { name: /^Model/ }).first().click();
		const info = w.page.getByLabel("Model catalogue information");
		await expect(info.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: T });
		const text = await info.innerText();
		assert.doesNotMatch(text, /catalogue|credential|Refresh the list/i);
		await shots(w, "picker-list-failed");
		w.model.answerListing(undefined);
		await info.getByRole("button", { name: "Try again" }).click();
		await expect(w.page.getByRole("radio", { name: /gpt-e2e/ }).first()).toBeVisible({ timeout: T });
	},
);

/** The first Pal, made the way a person makes it, and its own tab. */
async function createKiro(w) {
	const page = w.page;
	await expect(async () => {
		await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("region", { name: "Meet your Pal" })).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: T });
	await expect(async () => {
		const dialog = page.getByRole("dialog", { name: "Customize your Pal" });
		if (
			!(await dialog.isVisible()) &&
			!(await page.getByRole("button", { name: "Customize your Pal" }).isVisible())
		)
			await page.getByRole("button", { name: "Create your first Pal" }).click({ timeout: 2000 });
		if (!(await dialog.isVisible()))
			await page.getByRole("button", { name: "Customize your Pal" }).click({ timeout: 2000 });
		await expect(page.getByRole("dialog", { name: "Customize your Pal" })).toBeVisible({
			timeout: 2000,
		});
	}).toPass({ timeout: T });
	const customize = page.getByRole("dialog", { name: "Customize your Pal" });
	await customize.getByRole("textbox", { name: "Pal name" }).fill("Kiro");
	await customize.getByRole("textbox", { name: "Pal name" }).press("Enter");
	await expect(page.getByRole("tab", { name: "Kiro" })).toBeVisible({ timeout: T });
}

flow(
	"a Pal conversation shows the same provider wait line as a project conversation",
	{
		env: { NAMZU_E2E_PAL_COMPUTER: "fake" },
		rules: [
			{
				match: /busy/i,
				steps: [
					{
						status: 429,
						headers: { "retry-after": "8" },
						body: JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }),
					},
				],
			},
		],
	},
	async (w) => {
		await openProject(w);
		await createKiro(w);
		await send(w, "the provider is busy");
		const line = w.page.locator(".pal-chat-status");
		await expect(line).toContainText(
			new RegExp(`Waiting for ${PROVIDER_NAME} to accept more requests… retrying in \\d+s`),
			{ timeout: T },
		);
		await shots(w, "pal-rate-limit-wait");
	},
);

for (const [status, contentType, body, tail, shotName] of [
	[500, "application/json", JSON.stringify({ error: { message: "The server had an error.", type: "server_error" } }), "\\(500", "pal-500"],
	[502, "text/html", "<html><body>502 Bad Gateway</body></html>", "\\(502 Bad Gateway\\)", "pal-502"],
	[503, "text/html", "<html><head><title>503 Service Unavailable</title></head><body><h1>503 Service Unavailable</h1></body></html>", "\\(503 Service Unavailable\\)", "pal-503"],
]) {
	flow(
		`a Pal conversation that fails with ${status} before any reply shows the same row and Details, with no usage line`,
		{
			env: { NAMZU_E2E_PAL_COMPUTER: "fake" },
			rules: [{ match: /go wrong/i, steps: [{ status, contentType, body }] }],
		},
		async (w) => {
			await openProject(w);
			await createKiro(w);
			await send(w, "please go wrong");
			const region = w.page.locator(".turn-recovery");
			await expect(
				region.getByText("OpenAI had a problem on its side. Namzu can’t repeat this reply, so continue without it to put your message back in the message box.", { exact: true }),
			).toBeVisible({ timeout: T });
			// A Pal's turn is limited, so the failure and the refusal to repeat it are one message with
			// the one way on, and no Retry.
			await expect(region.locator(".turn-recovery-text")).toHaveCount(1);
			await expect(region.getByRole("button", { name: "Continue without this reply" })).toBeVisible();
			await expect(region.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
			const visible = (await region.innerText()).replace(/Details[\s\S]*$/, "");
			assert.doesNotMatch(visible, JARGON, "the headline carries no code, markup or accounting words");
			await region.getByRole("button", { name: "Details", exact: true }).click();
			const details = await region.locator(".turn-recovery-details-text").innerText();
			assert.match(details, new RegExp(`${PROVIDER_NAME}: the provider failed to complete the request ${tail}`));
			assert.doesNotMatch(details, /usage/i, "no reply arrived, so Details carry no usage line");
			assert.doesNotMatch(details, /[{}]|<\/?\w+>/, "labelled fields only, no JSON or markup");
			await shots(w, shotName);
		},
	);
}

flow(
	"an Anthropic 403 body is read into labelled fields, never printed as JSON",
	{
		messagesModels: ["claude-sonnet-5-5"],
		providers: [{ id: "anthropic", model: "claude-sonnet-5-5" }],
		messagesRules: [
			{
				match: /go wrong/i,
				steps: [
					{
						status: 403,
						contentType: "application/json",
						body: JSON.stringify({
							type: "error",
							error: { type: "permission_error", message: "Your account cannot use this model." },
						}),
					},
				],
			},
		],
	},
	async (w) => {
		await openProject(w);
		await expect(box(w)).toBeVisible({ timeout: T });
		await sendText(w, "please go wrong");
		const region = w.page.locator(".turn-recovery");
		await expect(region.getByRole("button", { name: "Details", exact: true })).toBeVisible({ timeout: T });
		await region.getByRole("button", { name: "Details", exact: true }).click();
		const details = await region.locator(".turn-recovery-details-text").innerText();
		assert.match(
			details,
			/\w+: access was refused\nStatus: 403 · Provider said: “Your account cannot use this model” · Type: permission_error/,
		);
		assert.doesNotMatch(details, /[{}"]|"type"/, "no JSON in Details");
		await shots(w, "403-anthropic-body");
	},
);
