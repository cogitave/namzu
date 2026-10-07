"use strict";
// Three identical, bounded human-style reads in a fresh native profile. Reuses
// the pinned proof's process/cleanup/owner checks. No installed profile edits.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const original = path.resolve(
	__dirname,
	"../runtime-desktop-20260930/native-harness-isolated-real-20261006.cjs",
);
const bytes = fs.readFileSync(original);
// The pin is set only after inspecting the exact inherited file.
const expected =
	"ea0a2ebc3b18e69b2e396230a24976d3f78a3bf83041397cb1ef72bb7e70d6e7";
assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), expected);
assert(
	!process.argv.some((arg) =>
		/pal-only|verify-removal|verify-pal-removal|reuse-owned-fixture/.test(arg),
	),
	"Only the three fresh read turns are supported.",
);
let code = bytes.toString("utf8");
function replaceOnce(before, after) {
	assert.equal(
		code.split(before).length,
		2,
		"Inherited human proof seam changed.",
	);
	code = code.replace(before, after);
}
replaceOnce("maximumRealPrompts: 4,", "maximumRealPrompts: 3,");
replaceOnce(
	"if (!process.argv.includes('--execute') || process.env.NAMZU_REAL_HARNESS_PROOF !== '1') {",
	"plan.schema = 'namzu.native-human-read-plan.v1';\n" +
		"for (const key of ['optionalFixtureRemoval', 'palOnlyRecheck', 'optionalPalRemoval']) delete plan[key];\n" +
		"plan.promptBoundary = 'One identical English read-only fixture request per engine; exact facts and actual tool/status events checked.';\n" +
		"if (!process.argv.includes('--execute') || process.env.NAMZU_REAL_HARNESS_PROOF !== '1') {",
);
replaceOnce(
	"schema: 'namzu.native-harness-isolated-real.v1',",
	"schema: 'namzu.native-human-read-real.v1',",
);
// Model selection stays open to permit effort selection. Use its actual trigger
// to close it, rather than assuming Escape owns focus over every nested tooltip.
replaceOnce(
	"\tif (await popup.isVisible()) await page.keyboard.press('Escape');\n\tconst route",
	"\tif (await popup.isVisible()) { await page.getByRole('button', { name: 'Select model', exact: true }).click(); await popup.waitFor({ state: 'hidden' }); }\n\tconst route",
);
replaceOnce(
	"\t\tawait page.keyboard.press('Escape');\n\t\tawait popup.waitFor({ state: 'hidden' });\n\t}\n\tconst after = await desktop.evaluate",
	"\t\tawait page.getByRole('button', { name: 'Select model', exact: true }).click();\n\t\tawait popup.waitFor({ state: 'hidden' });\n\t}\n\tconst after = await desktop.evaluate",
);
replaceOnce(
	"maxRealPrompts: palOnly ? 0 : reuse ? 1 : 4,",
	"maxRealPrompts: 3,",
);
replaceOnce(
	"const preference = ['gpt-6.1-luna', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6-sol'];",
	"const preference = ['gpt-6.1-luna', 'gpt-6-luna', 'gpt-5.6-luna'];",
);
replaceOnce(
	"models.find((item) => /haiku/i.test(item.id)) ??\n\t\t\t\tmodels.find((item) => /sonnet/i.test(item.id)) ?? models[0]",
	"models.find((item) => /haiku/i.test(item.id))",
);
replaceOnce(
	"preference.map((id) => models.find((item) => item.id === id)).find(Boolean) ?? models[0]",
	"preference.map((id) => models.find((item) => item.id === id)).find(Boolean)",
);
const start = code.indexOf("async function sendOne(");
const end = code.indexOf("\nasync function runEngine(", start);
assert(start > 0 && end > start);
code =
	code.slice(0, start) +
	require("./native-human-read-turn.cjs").toString() +
	"\n" +
	code.slice(end);
replaceOnce(
	"\tif (engine === 'codex-cli') {\n\t\tconst alternative",
	"\tif (false) {\n\t\tconst alternative",
);
replaceOnce(
	"\t\titem.stopReason === 'end_turn' && item.assistantRows > 0 && item.routeMatches)",
	"\t\titem.stopReason === 'end_turn' && item.assistantRows > 0 && item.routeMatches && item.factsMatch && item.toolRows > 0 && item.completedToolRows > 0 && !item.liveStatusVisible)",
);
replaceOnce(
	"\t\t(palOnly || Boolean(reuse) || Boolean(receipt.engines.find((entry) => entry.engine === 'codex-cli')?.switchedModel)) &&\n",
	"",
);
replaceOnce(
	"'Tool-free prompts do not prove Ask first approval or Full access enforcement.'",
	"'Read-only fixture turns and draft mode selection do not prove write/destructive/Full access policy enforcement.'",
);
const inherited = new Module(original, module);
inherited.filename = original;
inherited.paths = Module._nodeModulePaths(path.dirname(original));
inherited._compile(code, original);
