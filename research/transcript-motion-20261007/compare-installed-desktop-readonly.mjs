// Read bounded trees through /mnt/c; never mutate the installation or run JS.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const root = process.cwd();
const launch = JSON.parse(fs.readFileSync("/mnt/c/Users/Arda/AppData/Local/Namzu/Development/launch.json", "utf8"));
assert(/^C:\\Users\\Arda\\AppData\\Local\\Namzu\\Development\\app$/.test(launch.app));
const installed = `/mnt/c/${launch.app.slice(3).replaceAll("\\", "/")}/dist`;
const built = path.join(root, "packages/desktop/dist");
function inventory(directory) {
	const files = new Map();
	let total = 0;
	function visit(current, depth) {
		assert(depth <= 8);
		assert(fs.lstatSync(current).isDirectory() && !fs.lstatSync(current).isSymbolicLink());
		for (const name of fs.readdirSync(current).sort()) {
			const file = path.join(current, name), stat = fs.lstatSync(file);
			assert(!stat.isSymbolicLink(), "Redirected dist entry refused.");
			if (stat.isDirectory()) visit(file, depth + 1);
			else {
				assert(stat.isFile() && stat.size <= 64 * 1024 * 1024);
				assert(files.size < 5000 && (total += stat.size) < 512 * 1024 * 1024);
				const bytes = fs.readFileSync(file);
				assert.equal(bytes.length, stat.size);
				files.set(path.relative(directory, file).replaceAll(path.sep, "/"), { sha256: hash(bytes), size: bytes.length, bytes });
			}
		}
	}
	visit(directory, 0);
	return files;
}
const before = inventory(installed), after = inventory(built);
const changed = [], removed = [], added = [], identical = [];
for (const [file, value] of before) {
	const current = after.get(file);
	if (!current) removed.push({ path: file, sha256: value.sha256, bytes: value.size });
	else if (current.sha256 !== value.sha256) changed.push({ path: file, installedSha256: value.sha256, builtSha256: current.sha256, installedBytes: value.size, builtBytes: current.size });
	else identical.push(file);
}
for (const [file, value] of after) if (!before.has(file)) added.push({ path: file, sha256: value.sha256, bytes: value.size });
const htmlPath = "renderer/index.html";
const htmlBefore = before.get(htmlPath)?.bytes.toString("utf8"), htmlAfter = after.get(htmlPath)?.bytes.toString("utf8");
assert(htmlBefore && htmlAfter);
const references = html => ({ js: [...html.matchAll(/<script\b[^>]*\bsrc="(\.\/assets\/[^"<>]+\.js)"/g)].map(match => match[1]), css: [...html.matchAll(/<link\b[^>]*\bhref="(\.\/assets\/[^"<>]+\.css)"/g)].map(match => match[1]) });
const installedRefs = references(htmlBefore), builtRefs = references(htmlAfter);
const normalization = { installedRefs, builtRefs, exactCssReferenceSubstitutionOnly: false, htmlAfterVerifiedReferenceSubstitutionsEqual: false };
if (installedRefs.js.length === 1 && builtRefs.js.length === 1 && installedRefs.css.length === 1 && builtRefs.css.length === 1) {
	const oldJs = `renderer/${installedRefs.js[0].slice(2)}`, newJs = `renderer/${builtRefs.js[0].slice(2)}`;
	const oldCss = installedRefs.css[0].split("/").at(-1), newCss = builtRefs.css[0].split("/").at(-1);
	const oldJsBytes = before.get(oldJs)?.bytes, newJsBytes = after.get(newJs)?.bytes;
	if (oldJsBytes && newJsBytes) {
		const oldText = oldJsBytes.toString("utf8"), newText = newJsBytes.toString("utf8");
		const occurrences = oldText.split(oldCss).length - 1;
		const normalized = oldText.replaceAll(oldCss, newCss);
		normalization.exactCssReferenceSubstitutionOnly = normalized === newText;
		normalization.js = { installedPath: oldJs, builtPath: newJs, installedSha256: hash(oldJsBytes), builtSha256: hash(newJsBytes), exactOldCssFilename: oldCss, exactNewCssFilename: newCss, substitutions: occurrences, normalizedInstalledSha256: hash(normalized) };
		if (normalization.exactCssReferenceSubstitutionOnly) {
			const normalizedHtml = htmlBefore.replaceAll(installedRefs.css[0], builtRefs.css[0]).replaceAll(installedRefs.js[0], builtRefs.js[0]);
			normalization.htmlAfterVerifiedReferenceSubstitutionsEqual = normalizedHtml === htmlAfter;
			normalization.normalizedInstalledHtmlSha256 = hash(normalizedHtml);
		}
	}
}
const js = file => /\.(?:js|cjs|mjs)$/.test(file);
const receipt = {
	schema: "namzu.desktop-installed-build-readonly-comparison.v1", at: new Date().toISOString(), readOnly: true,
	installedFiles: before.size, builtFiles: after.size, identicalFiles: identical.length,
	changed, removed, added, normalization,
	nativeMainPreloadAllJsByteExact: !changed.some(row => js(row.path)) && !removed.some(row => js(row.path)) && !added.some(row => js(row.path)),
	nonRendererJsByteExact: !changed.some(row => js(row.path) && !row.path.startsWith("renderer/")) && !removed.some(row => js(row.path) && !row.path.startsWith("renderer/")) && !added.some(row => js(row.path) && !row.path.startsWith("renderer/")),
	mainIndex: { installedSha256: before.get("main/index.js")?.sha256 ?? null, builtSha256: after.get("main/index.js")?.sha256 ?? null },
	preload: { installedSha256: before.get("preload.cjs")?.sha256 ?? null, builtSha256: after.get("preload.cjs")?.sha256 ?? null },
	limits: ["Bytes only; no installed script execution, restart, style injection or mutation.", "Normalization permits only the exact old/new CSS filename from HTML; HTML JS filename substitution is allowed only after independently proving the corresponding JS differs solely in that CSS filename."]
};
const directory = path.join(root, "research/transcript-motion-20261007/artifacts");
const file = path.join(directory, `installed-css-comparison-${crypto.randomUUID()}.json`);
fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...receipt, receipt: path.relative(root, file) }, null, 2));
