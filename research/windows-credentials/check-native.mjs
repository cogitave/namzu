// Run from any directory: node research/windows-credentials/check-native.mjs
// An optional first argument names native Windows node.exe when running from WSL.
// Only fresh Windows TEMP fixtures are changed; no login or provider is contacted.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const baselineCommit = "e5bd6a27";
const files = [
	"integrations/providers/credential-store.ts",
	"integrations/providers/harness-credentials.ts",
	"integrations/state/home.ts",
	"integrations/state/private-directory.ts",
];
const modules = {};
for (const version of ["before", "after"]) {
	for (const name of files) {
		const sourcePath = `packages/cli/src/${name}`;
		const source =
			version === "before"
				? execFileSync("git", ["show", `${baselineCommit}:${sourcePath}`], {
						cwd: root,
						encoding: "utf8",
					})
				: readFileSync(
						new URL(sourcePath, new URL("../../", import.meta.url)),
						"utf8",
					);
		modules[`${version}/${name.replace(/\.ts$/u, ".js")}`] = ts.transpileModule(
			source,
			{
				compilerOptions: {
					module: ts.ModuleKind.ES2022,
					target: ts.ScriptTarget.ES2022,
				},
			},
		).outputText;
	}
}

const nativeNode =
	process.argv[2] ??
	(process.platform === "win32"
		? process.execPath
		: "/mnt/c/Program Files/nodejs/node.exe");

// Serialize source as data into the native process. Shell interpolation is never used.
const script = `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
assert.equal(process.platform, 'win32', 'This probe requires native Windows Node');
const root = mkdtempSync(join(tmpdir(), 'namzu-windows-credentials-'));
try {
	const modules = ${JSON.stringify(modules)};
	writeFileSync(join(root, 'package.json'), '{"type":"module"}');
	for (const [name, source] of Object.entries(modules)) {
		const path = join(root, name);
		mkdirSync(dirname(path), {recursive:true});
		writeFileSync(path, source);
	}
	const load = (version, name) => import(pathToFileURL(join(root, version, 'integrations', name + '.js')));
	const before = await load('before', 'state/private-directory');
	const after = await load('after', 'state/private-directory');
	const store = await load('after', 'providers/credential-store');
	const harness = await load('after', 'providers/harness-credentials');
	const sid = store.currentUserSid();
	assert.ok(sid, 'Native account SID unavailable');
	const icacls = join(process.env.SystemRoot, 'System32', 'icacls.exe');
	const state = join(root, 'state');
	const path = join(state, 'cli');
	mkdirSync(path, {recursive:true});
	execFileSync(icacls, [path, '/inheritance:r', '/grant:r', '*' + sid + ':F', '*S-1-5-18:F'], {stdio:'ignore'});
	let originalError;
	assert.throws(() => before.ensurePrivateStateDirectory(state, 'cli'), error => {
		originalError = error.message.replaceAll(path, '<fixture>/cli');
		return originalError.includes('account other than yours (SY)');
	});
	assert.equal(after.ensurePrivateStateDirectory(state, 'cli'), path);
	assert.ok(store.readAclSddl(path).includes(';;;SY)'));
	assert.equal(after.ensurePrivateStateDirectory(state, 'cli'), path);
	execFileSync(icacls, [path, '/grant:r', '*S-1-1-0:F'], {stdio:'ignore'});
	assert.throws(() => after.ensurePrivateStateDirectory(state, 'cli'), /account other than yours/);
	assert.throws(() => store.assertSoleOwnerSddl('D:P(A;;FA;;;SY)', sid, 'synthetic'), /your account/);
	const fresh = after.ensurePrivateStateDirectory(root, 'fresh');
	store.assertSoleOwnerSddl(store.readAclSddl(fresh), sid, fresh);
	const syntheticHome = join(root, 'home');
	const custom = join(root, 'Claude profile with spaces');
	mkdirSync(custom);
	const ownerPath = join(custom, '.credentials.json');
	writeFileSync(ownerPath, JSON.stringify({claudeAiOauth:{accessToken:'synthetic-access'}}));
	const candidates = harness.readClaudeFileCredentialCandidates(syntheticHome, {CLAUDE_CONFIG_DIR:custom}, null);
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].path, ownerPath);
	assert.equal(candidates[0].credential.accessToken, 'synthetic-access');
	console.log(JSON.stringify({
		date: '2026-09-11',
		baselineCommit: '${baselineCommit}',
		platform: process.platform,
		node: process.version,
		originalError,
		checks: {
			originalSystemRefusalReproduced: true,
			ownerAndSystemAccepted: true,
			repeatedStartupAccepted: true,
			everyoneGrantRefused: true,
			systemOnlyDescriptorRefused: true,
			freshPrivateDirectoryAccepted: true,
			customClaudeProfileWithSpacesRead: true
		},
		exercised: ['ensurePrivateStateDirectory', 'restrictToOwner', 'currentUserSid', 'readAclSddl', 'assertSoleOwnerSddl', 'readClaudeFileCredentialCandidates', 'native whoami.exe', 'native icacls.exe'],
		boundary: 'Repository TypeScript modules transpiled into isolated Windows TEMP directories and executed by native Windows Node. Synthetic credentials only. No full Windows TUI, real provider inference, or login test.'
	}, null, 2));
} finally {
	rmSync(root, {recursive:true, force:true});
}
`;

process.stdout.write(
	execFileSync(nativeNode, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		timeout: 30_000,
	}),
);
