// Compiles the TypeScript in `docs/` against the built SDK.
//
// `check-docs.mjs` has five fatal checks and every one is about a document's
// METADATA. `DRIFT` says a page might be stale because its `resource:` moved;
// it says nothing about a fence naming a symbol that no longer exists in a
// page whose `resource:` did not move. So `docs/` carried 184 ```ts fences
// that nothing had ever compiled, and a rename could pass every gate in the
// repository while leaving documentation that does not build.
//
// Three fence kinds, and the second two exist because forcing every fence
// through a compiler produces either noise or a wall of `// @ts-ignore`:
//
//   ```ts            compiled. A diagnostic is fatal.
//   ```ts sketch     NOT compiled, and counted out loud. An acknowledged
//                    opt-out for illustrative shapes, pseudo-config and
//                    fragments that were never meant to build.
//   ```ts verbatim   not compiled; asserted to appear, byte for byte, in the
//                    file its `// from: <path>` marker names. For a snippet
//                    whose value is that it IS the shipped code.
//
// Scope is `FENCE_CONFORMING`, the same discipline `check-docs.mjs` uses and
// for the same reason: a gate that claims the whole tree on day one gets
// switched off on day two. Every run prints what it did NOT look at.
//
// Usage: node tools/check-doc-fences.mjs [rootDir]

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Directories whose fences are compiled.
 *
 * Add one in the same change that makes its fences build, never before —
 * an entry listing files with no compilable fence is caught by the
 * zero-count guard at the bottom.
 */
const FENCE_CONFORMING = ["docs"];

const root = resolve(process.argv[2] ?? join(import.meta.dirname, ".."));
const distDir = join(root, "packages", "sdk", "dist");
const rel = (p) => relative(root, p).split("\\").join("/");

/** Publishable packages whose built types are missing — see `fencePaths`. */
const unbuilt = [];

/**
 * What a fence is allowed to import, mapped to the artifact a reader would
 * actually get.
 *
 * This was one entry, `@namzu/sdk`, and that quietly decided which pages
 * could EVER come under this gate: a page documenting `@namzu/lsp` or
 * `@namzu/computer-use` fails with TS2307 on its first line no matter how
 * correct it is, so the adoption path the header describes was closed for
 * every optional package in the repo.
 *
 * Derived from the workspace rather than listed, for the reason the publint
 * step learned the hard way: a hand-written list of packages is wrong the
 * day someone adds one. Every publishable package's every `types` condition
 * is mapped, so `@namzu/files/local` resolves as readily as `@namzu/files`.
 *
 * `zod` is here because it is a real peer dependency a reader has, and pnpm
 * puts it under `packages/sdk/node_modules` rather than at the root where
 * the virtual fence file sits — so `import { z } from "zod"`, which is the
 * first line of half the tool documentation, could not resolve.
 */
function fencePaths() {
	const paths = {};
	const toPosix = (p) => p.split("\\").join("/");
	const packagesDir = join(root, "packages");
	const dirs = [];
	for (const name of readdirSync(packagesDir)) {
		if (name === "node_modules") continue;
		const dir = join(packagesDir, name);
		if (!statSync(dir).isDirectory()) continue;
		if (existsSync(join(dir, "package.json"))) {
			dirs.push(dir);
			continue;
		}
		for (const nested of readdirSync(dir)) {
			if (existsSync(join(dir, nested, "package.json")))
				dirs.push(join(dir, nested));
		}
	}
	for (const dir of dirs) {
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		if (manifest.private || !manifest.exports) continue;
		for (const [subpath, condition] of Object.entries(manifest.exports)) {
			if (subpath.includes("*") || subpath === "./package.json") continue;
			const types =
				typeof condition === "object" ? condition.types : undefined;
			if (typeof types !== "string") continue;
			const specifier =
				subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
			const target = join(dir, types);
			// An unbuilt sibling is NOT "this package has no types". Skipping it
			// silently turns a missing build step into TS2307 on the reader's
			// import line, which is a wrong diagnosis of a right complaint — the
			// exact failure this gate produced in CI the first time it ran with
			// more than one package in the map.
			if (!existsSync(target)) {
				unbuilt.push(specifier);
				continue;
			}
			paths[specifier] = [toPosix(target)];
		}
	}
	const zod = join(root, "packages", "sdk", "node_modules", "zod");
	if (existsSync(zod)) paths.zod = [toPosix(zod)];
	return paths;
}

const FENCE_PATHS = fencePaths();

let problems = 0;
const fail = (...lines) => {
	for (const l of lines) console.log(l);
	problems += 1;
};

function markdownUnder(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) out.push(...markdownUnder(p));
		else if (entry.endsWith(".md")) out.push(p);
	}
	return out;
}

/** Every ```ts fence in one file, with the 1-based line its opener sat on. */
function fences(text) {
	const lines = text.split("\n");
	const found = [];
	let open = null;
	lines.forEach((line, i) => {
		const m = /^```ts(\s+(sketch|verbatim))?\s*$/.exec(line);
		if (m && open === null) {
			open = { kind: m[2] ?? "compile", startLine: i + 1, body: [] };
			return;
		}
		if (open && /^```\s*$/.test(line)) {
			found.push({ ...open, body: open.body.join("\n") });
			open = null;
			return;
		}
		if (open) open.body.push(line);
	});
	return found;
}

// ---------------------------------------------------------------------------
// verbatim: the fence must BE the code
// ---------------------------------------------------------------------------

function checkVerbatim(file, fence) {
	const marker = /^\s*\/\/\s*from:\s*(\S+)\s*$/m.exec(fence.body);
	if (!marker) {
		fail(
			`${rel(file)}:${fence.startLine} a \`ts verbatim\` fence needs a \`// from: <path>\` marker`,
			"    Without it nothing says which file it is supposed to match, and the fence is an ordinary uncompiled snippet wearing a stronger word.",
		);
		return;
	}
	const target = join(root, marker[1]);
	if (!existsSync(target)) {
		fail(
			`${rel(file)}:${fence.startLine} \`// from: ${marker[1]}\` names a file that does not exist`,
		);
		return;
	}
	const source = readFileSync(target, "utf8");
	const snippet = fence.body
		.split("\n")
		.filter((l) => !/^\s*\/\/\s*from:/.test(l))
		.join("\n")
		.trim();
	if (!source.includes(snippet)) {
		fail(
			`${rel(file)}:${fence.startLine} the fence is not present verbatim in ${marker[1]}`,
			"    A `verbatim` fence claims to be the shipped code. Update the fence, or drop the word.",
		);
	}
}

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

const PREAMBLE_MARKER = "/* doc-fence preamble */";

/**
 * A fence is a fragment, not a module. Anything it references has to come
 * from somewhere, and the somewhere is the built package — the same artifact
 * a reader installs. Typechecking against `src/` would let a fence pass
 * against an internal name the package does not export.
 */
function wrap(body) {
	// One import line, so the offset from a diagnostic's line to the fence's
	// is a constant the reporter can subtract.
	return `${PREAMBLE_MARKER}\n${body}\n`;
}

function compileFences(units) {
	if (units.length === 0) return;
	const files = new Map(units.map((u) => [u.virtualPath, wrap(u.fence.body)]));
	const host = ts.createCompilerHost({}, true);
	const originalGetSourceFile = host.getSourceFile;
	host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
		const contents = files.get(name);
		if (contents !== undefined) {
			return ts.createSourceFile(name, contents, languageVersion, true);
		}
		return originalGetSourceFile.call(
			host,
			name,
			languageVersion,
			onError,
			shouldCreate,
		);
	};
	host.fileExists = (name) => files.has(name) || ts.sys.fileExists(name);
	host.readFile = (name) => files.get(name) ?? ts.sys.readFile(name);

	const program = ts.createProgram(
		[...files.keys()],
		{
			target: ts.ScriptTarget.ES2022,
			// ESNext + Bundler, deliberately, and NOT the SDK's own NodeNext.
			// A fence is a fragment a reader copies into their own file, and
			// under NodeNext a bare `.ts` with no neighbouring package.json
			// `type` is inferred CommonJS — so every `await` at fence top level
			// became TS1309, which says nothing about the documentation and
			// everything about the harness.
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			// The specifiers a READER writes. Mapped to the built packages, so a
			// fence that names an internal symbol a package does not export
			// fails here rather than passing against `src/`. See `fencePaths`.
			paths: FENCE_PATHS,
			strict: true,
			noEmit: true,
			skipLibCheck: true,
			allowJs: false,
		},
		host,
	);

	const byPath = new Map(units.map((u) => [u.virtualPath, u]));
	for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
		const unit = diagnostic.file
			? byPath.get(diagnostic.file.fileName)
			: undefined;
		if (!unit) continue;
		const message = ts.flattenDiagnosticMessageText(
			diagnostic.messageText,
			" ",
		);
		// The preamble occupies one line above the fence body; report the
		// reader's line, not the wrapper's.
		const { line } = diagnostic.file.getLineAndCharacterOfPosition(
			diagnostic.start ?? 0,
		);
		const docLine = unit.fence.startLine + Math.max(0, line);
		fail(`${rel(unit.file)}:${docLine} TS${diagnostic.code} ${message}`);
	}
}

// ---------------------------------------------------------------------------

if (unbuilt.length > 0) {
	console.log(
		`doc-fence gate: ${unbuilt.length} publishable entry point(s) are not built:`,
	);
	for (const specifier of unbuilt) console.log(`  - ${specifier}`);
	console.log("  Run: pnpm -r build");
	console.log(
		"  Refusing rather than compiling without them: an unmapped specifier fails as",
	);
	console.log(
		"  TS2307 on the reader's import line, which blames the documentation for a",
	);
	console.log("  missing build step.");
	process.exit(1);
}

if (!existsSync(join(distDir, "index.d.ts"))) {
	console.log("doc-fence gate: packages/sdk/dist is missing.");
	console.log("  Run: pnpm --filter @namzu/sdk build");
	console.log(
		"  Refusing rather than passing: with no build there is nothing to compile against,",
	);
	console.log(
		"  and a gate that skips itself when its input is absent reports health it never checked.",
	);
	process.exit(1);
}

const scoped = [];
for (const dir of FENCE_CONFORMING)
	scoped.push(...markdownUnder(join(root, dir)));

let compiled = 0;
let sketched = 0;
let verbatim = 0;
const units = [];

for (const file of scoped) {
	const text = readFileSync(file, "utf8");
	for (const fence of fences(text)) {
		if (fence.kind === "sketch") {
			sketched += 1;
			continue;
		}
		if (fence.kind === "verbatim") {
			verbatim += 1;
			checkVerbatim(file, fence);
			continue;
		}
		compiled += 1;
		units.push({
			file,
			fence,
			virtualPath: join(root, `.doc-fence-${units.length}.ts`),
		});
	}
}

compileFences(units);

const allDocs = markdownUnder(join(root, "docs"));
const outside = allDocs.filter((p) => !scoped.includes(p)).length;

// A gate that compiled nothing passes for the wrong reason. Emptying
// `FENCE_CONFORMING`, or pointing it at a directory whose fences are all
// `sketch`, would otherwise report success — which is the shape this whole
// file exists to prevent elsewhere.
if (compiled === 0) {
	fail(
		"doc-fence gate: no fence was compiled.",
		"    FENCE_CONFORMING is empty, or names only directories whose fences are all `sketch`.",
		"    Reporting success here would make the gate decorative.",
	);
}

console.log(`doc-fence gate: ${problems} problem(s)`);
console.log(
	`           ${compiled} fence(s) compiled against packages/sdk/dist`,
);
console.log(
	`           ${sketched} \`ts sketch\` fence(s) skipped by declaration`,
);
console.log(
	`           ${verbatim} \`ts verbatim\` fence(s) compared against their source`,
);
console.log(
	`           ${outside} file(s) under docs/ outside FENCE_CONFORMING`,
);
process.exit(problems ? 1 : 0);
