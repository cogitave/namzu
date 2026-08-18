import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { loadSkill } from '../skills/loader.js'
import type { ToolDefinition } from '../types/tool/index.js'

import { canonicalRoot, scanSlot } from './scan.js'
import type {
	DirectoryConfig,
	DirectoryDiagnostic,
	DirectoryLoadResult,
	DirectorySlot,
	LoadDirectoryOptions,
	ModuleImporter,
	ModuleMode,
	SkillEntry,
	SourceOutcome,
	SourceRef,
	SubAgentEntry,
	ToolEntry,
} from './types.js'
import { ALL_SLOTS } from './types.js'

const DEFAULT_MODULE_TIMEOUT_MS = 10_000

/**
 * Import a module with a deadline that bounds the LOADER, not the module.
 *
 * `import()` cannot be cancelled. When this races out, the module is still
 * executing: it may finish, its top-level side effects may land after
 * `loadDirectory` has returned, and Node caches the result — so a second load in
 * the same process can see the same file resolve instantly. That was verified
 * rather than assumed, and it is why `'abandoned'` exists as an outcome
 * separate from `'failed'`.
 */
async function importWithDeadline(
	fileUrl: string,
	importModule: ModuleImporter,
	timeoutMs: number,
): Promise<
	| { status: 'loaded'; module: unknown }
	| { status: 'abandoned' }
	/** `code` is Node's `err.code`, which its `message` does not contain. */
	| { status: 'failed'; cause: string; code?: string }
> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const deadline = new Promise<{ status: 'abandoned' }>((resolve) => {
		timer = setTimeout(() => resolve({ status: 'abandoned' }), timeoutMs)
	})
	try {
		const result = await Promise.race([
			importModule(fileUrl).then((module) => ({
				status: 'loaded' as const,
				module,
			})),
			deadline,
		])
		return result
	} catch (err) {
		const code = (err as { code?: unknown } | null)?.code
		return {
			status: 'failed',
			cause: err instanceof Error ? err.message : String(err),
			...(typeof code === 'string' ? { code } : {}),
		}
	} finally {
		if (timer) clearTimeout(timer)
	}
}

/**
 * Translate Node's module-loading errors into something an author can act on.
 *
 * The codes matter more than the messages: `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
 * means the file used a construct type STRIPPING cannot express (an `enum`, a
 * decorator, a parameter property) — stripping erases types, it does not
 * transform code, and no flag rescues those. That is a different problem from
 * a plain syntax error, and pointing at the wrong one costs an author an hour.
 *
 * That sentence was true and this function still matched on `cause`, which is
 * `err.message` — and Node does not put the code in the message. Probed:
 * `ERR_MODULE_NOT_FOUND` arrives as *"Cannot find module …"*, and
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` as *"TypeScript enum is not supported in
 * strip-only mode"*. Neither contains its code, so every branch below was
 * unreachable and every author got the bare message the doc-comment was
 * explaining why not to give them. The code is read from `err.code` now, which
 * is where it always was.
 */
function explainImportFailure(cause: string, code?: string): string {
	if (code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
		return `${cause}\n\nNode strips types, it does not compile them: enums, decorators, parameter properties and runtime namespaces have no stripped form. Rewrite as plain TypeScript, or pass \`importModule\` with a transforming loader.`
	}
	if (code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') {
		return `${cause}\n\nNode refuses to strip types from any .ts file resolved under node_modules/. If this is a workspace package, have it ship built .js.`
	}
	if (code === 'ERR_MODULE_NOT_FOUND') {
		return `${cause}\n\nRelative imports need their real extension here — write "./util.ts", not "./util". tsconfig "paths" aliases are not resolved; pass \`importModule\` if you need them.`
	}
	// Node ≥20 but <22.6 has no type stripping at all, so the golden path — a
	// `.ts` tool — dies here rather than at any of the codes above.
	if (code === 'ERR_UNKNOWN_FILE_EXTENSION' && /\.[cm]?ts"?$/.test(cause)) {
		return `${cause}\n\nThis Node cannot run TypeScript directly. Use Node 22.18 or newer, or pass \`importModule\` with a loader that transpiles.`
	}
	return cause
}

/**
 * The fields `ToolDefinition` declares without a `?`.
 *
 * Checking `name` and `execute` alone was not a weaker version of this check,
 * it was a check that let the failure through and moved it: a default export
 * with no `inputSchema` passed here, registered clean, and then died inside
 * `toLLMTools()` reading `inputSchema._def` — a `TypeError` naming a file this
 * loader never mentions, at a point where the author is no longer looking at
 * their tool. A loader whose job is to report bad files must reject the ones
 * that crash later, not only the ones that are obviously not tools.
 *
 * Exactly the required set, and no more. `isReadOnly`, `isDestructive` and the
 * other `defineTool` niceties are not on the interface, so demanding them would
 * make this loader refuse a hand-written object that satisfies the SDK's own
 * published type — the loader overruling the SDK.
 */
function isToolDefinition(value: unknown): value is ToolDefinition {
	if (typeof value !== 'object' || value === null) return false
	const c = value as Record<string, unknown>
	return (
		typeof c.name === 'string' &&
		typeof c.description === 'string' &&
		typeof c.execute === 'function' &&
		typeof c.inputSchema === 'object' &&
		c.inputSchema !== null
	)
}

/** The default export, tolerating a namespace that only has named exports. */
function defaultExport(module: unknown): unknown {
	if (typeof module !== 'object' || module === null) return undefined
	return (module as { default?: unknown }).default
}

function readConfig(
	value: unknown,
	diagnostics: DirectoryDiagnostic[],
	path: string,
): DirectoryConfig {
	if (value === undefined) return {}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		diagnostics.push({
			code: 'invalid_config',
			severity: 'error',
			message: 'agent.ts must default-export a plain object.',
			path,
		})
		return {}
	}
	// Read field by field rather than spread: an unknown key is the author's
	// business, but a known key of the wrong type would reach `runAgent` and
	// fail somewhere with no mention of this file.
	const raw = value as Record<string, unknown>
	const config: Record<string, unknown> = {}

	const take = (key: string, ok: (v: unknown) => boolean, expected: string): void => {
		const found = raw[key]
		if (found === undefined) return
		if (!ok(found)) {
			diagnostics.push({
				code: 'invalid_config',
				severity: 'error',
				message: `agent.ts: "${key}" must be a ${expected}, received ${typeof found}.`,
				path,
			})
			return
		}
		config[key] = found
	}

	const isString = (v: unknown): boolean => typeof v === 'string'
	// Rejects NaN and Infinity too. A budget of NaN compares false against
	// every limit, so it would read as "no cap" rather than as a bad value.
	const isNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)

	take('model', isString, 'string')
	take('name', isString, 'string')
	take('temperature', isNumber, 'finite number')
	take('maxIterations', isNumber, 'finite number')
	take('tokenBudget', isNumber, 'finite number')
	take('timeoutMs', isNumber, 'finite number')
	take('streamIdleTimeoutMs', isNumber, 'finite number')

	// `metadata` is typed `Record<string, string>` and was admitted on
	// `typeof === 'object'` alone — which an array also satisfies, and which
	// says nothing about the values. So `{ tags: ['a'] }` and `{ n: 1 }` both
	// reached a consumer that had been promised strings, and the type was a
	// claim this loader did not keep. Every other field here is checked; this
	// one is the reason to check the values too, since it is the only field
	// whose contents are forwarded verbatim to an inspector.
	if (raw.metadata !== undefined) {
		const m = raw.metadata
		if (typeof m !== 'object' || m === null || Array.isArray(m)) {
			diagnostics.push({
				code: 'invalid_config',
				severity: 'error',
				message: `agent.ts: "metadata" must be an object of string values, received ${Array.isArray(m) ? 'array' : typeof m}.`,
				path,
			})
		} else {
			const bad = Object.entries(m).filter(([, v]) => typeof v !== 'string')
			if (bad.length > 0) {
				diagnostics.push({
					code: 'invalid_config',
					severity: 'error',
					message: `agent.ts: "metadata" values must be strings; ${bad
						.map(([k, v]) => `"${k}" is ${v === null ? 'null' : typeof v}`)
						.join(', ')}.`,
					path,
				})
			} else {
				config.metadata = m
			}
		}
	}
	return config as DirectoryConfig
}

/**
 * Read a conventional agent directory into typed, inspectable definitions.
 *
 * A LOADER, not a runner: it produces what is there and hands it back. Running
 * it — a turn, a server, a schedule — is the host's job, which is what keeps
 * this package free of any hosting model.
 *
 * It never throws on authored content. A broken tool, a missing file, a
 * malformed config all come back as diagnostics, because a loader that throws
 * on the first bad file tells you about one problem when you wanted the list.
 */
export async function loadDirectory(
	dir: string,
	options: LoadDirectoryOptions = {},
): Promise<DirectoryLoadResult> {
	return loadAt(dir, options, 0)
}

/**
 * Depth 0 is the project the caller named; 1 is a delegate it declares.
 *
 * A delegate does not get delegates of its own. The cap is a real decision,
 * not a missing feature: unbounded nesting is a topology question — who may
 * spawn whom, and how deep a run may fan out — and answering it by default is
 * how a directory layout ends up deciding a system's shape. It also removes
 * the cycle: `agents/a/agents/b/agents/a` cannot be built if the second level
 * is never read.
 */
const MAX_DEPTH = 1

async function loadAt(
	dir: string,
	options: LoadDirectoryOptions,
	depth: number,
): Promise<DirectoryLoadResult> {
	if (typeof dir !== 'string' || dir.length === 0) {
		throw new TypeError('loadDirectory(dir): dir must be a non-empty string.')
	}

	const modules: ModuleMode = options.modules ?? 'evaluate'
	const importModule: ModuleImporter = options.importModule ?? ((url) => import(url))
	const timeoutMs = options.moduleTimeoutMs ?? DEFAULT_MODULE_TIMEOUT_MS
	// `?? ALL_SLOTS`, never `|| ALL_SLOTS`: an empty list means "scan nothing",
	// which is the closed reading of an allow-list. The tuple type keeps a
	// TypeScript caller from writing it at all.
	const included: readonly DirectorySlot[] = options.include ?? ALL_SLOTS

	const diagnostics: DirectoryDiagnostic[] = []
	const sources: SourceRef[] = []
	const tools: ToolEntry[] = []
	const skills: SkillEntry[] = []
	const agents: SubAgentEntry[] = []
	let config: DirectoryConfig = {}
	let instructions = ''

	const root = await canonicalRoot(dir)
	if (!root) {
		diagnostics.push({
			code: 'root_missing',
			severity: 'error',
			message: `No directory at ${dir}.`,
		})
		return {
			manifest: {
				root: dir,
				name: 'agent',
				instructions: '',
				config: {},
				tools: [],
				skills: [],
				agents: [],
				sources: [],
				included,
				modules,
			},
			diagnostics,
			ok: false,
		}
	}

	const record = (
		file: { path: string; relativePath: string; id: string },
		slot: DirectorySlot,
		outcome: SourceOutcome,
	): SourceRef => {
		const ref: SourceRef = { ...file, slot, outcome }
		sources.push(ref)
		return ref
	}

	// ─── instructions ─────────────────────────────────────────────────────
	if (included.includes('instructions')) {
		try {
			const body = await readFile(`${root}/instructions.md`, 'utf8')
			instructions = body.trimEnd()
			if (instructions.length === 0) {
				// Asymmetric on purpose: an absent file is a choice, a present
				// file that says nothing is a mistake.
				diagnostics.push({
					code: 'instructions_empty',
					severity: 'error',
					message: 'instructions.md exists but is empty.',
					path: `${root}/instructions.md`,
				})
			}
			record(
				{
					path: `${root}/instructions.md`,
					relativePath: 'instructions.md',
					id: 'instructions',
				},
				'instructions',
				'loaded',
			)
		} catch {
			// A warning, not an error: `runAgent` treats instructions as fully
			// optional, and this package does not get to overrule the kernel
			// about what a valid agent is.
			diagnostics.push({
				code: 'instructions_missing',
				severity: 'warning',
				message: 'No instructions.md. The agent will run without a system prompt.',
			})
		}
	}

	// ─── agent.ts ─────────────────────────────────────────────────────────
	if (included.includes('agent')) {
		const found = (await scanSlot(root, 'agent', '.')).files.find((f) => f.id === 'agent')
		if (found) {
			if (modules === 'skip') {
				record(found, 'agent', 'not_loaded')
			} else {
				const outcome = await importWithDeadline(
					pathToFileURL(found.path).href,
					importModule,
					timeoutMs,
				)
				if (outcome.status === 'loaded') {
					config = readConfig(defaultExport(outcome.module), diagnostics, found.path)
					record(found, 'agent', 'loaded')
				} else if (outcome.status === 'abandoned') {
					diagnostics.push({
						code: 'module_load_abandoned',
						severity: 'error',
						message: `agent.ts did not finish importing within ${timeoutMs}ms. The import was not cancelled and may still complete.`,
						path: found.path,
					})
					record(found, 'agent', 'abandoned')
				} else {
					diagnostics.push({
						code: 'module_load_failed',
						severity: 'error',
						message: 'agent.ts could not be imported.',
						path: found.path,
						cause: explainImportFailure(outcome.cause, outcome.code),
					})
					record(found, 'agent', 'failed')
				}
			}
		}
	}

	// ─── tools ────────────────────────────────────────────────────────────
	if (included.includes('tools')) {
		const scan = await scanSlot(root, 'tools', 'tools')
		diagnostics.push(...scan.diagnostics)
		const seen = new Map<string, string>()

		for (const file of scan.files) {
			if (modules === 'skip') {
				record(file, 'tools', 'not_loaded')
				continue
			}
			const outcome = await importWithDeadline(
				pathToFileURL(file.path).href,
				importModule,
				timeoutMs,
			)
			if (outcome.status === 'abandoned') {
				diagnostics.push({
					code: 'module_load_abandoned',
					severity: 'error',
					message: `${file.relativePath} did not finish importing within ${timeoutMs}ms. The import was not cancelled and may still complete.`,
					path: file.path,
				})
				record(file, 'tools', 'abandoned')
				continue
			}
			if (outcome.status === 'failed') {
				diagnostics.push({
					code: 'module_load_failed',
					severity: 'error',
					message: `${file.relativePath} could not be imported.`,
					path: file.path,
					cause: explainImportFailure(outcome.cause, outcome.code),
				})
				record(file, 'tools', 'failed')
				continue
			}

			const exported = defaultExport(outcome.module)
			if (exported === undefined) {
				diagnostics.push({
					code: 'no_default_export',
					severity: 'error',
					message: `${file.relativePath} has no default export. A tool file default-exports the result of defineTool().`,
					path: file.path,
				})
				record(file, 'tools', 'failed')
				continue
			}
			if (!isToolDefinition(exported)) {
				diagnostics.push({
					code: 'not_a_tool',
					severity: 'error',
					message: `${file.relativePath} default-exports something that is not a tool definition (needs a "name" and an "execute").`,
					path: file.path,
				})
				record(file, 'tools', 'failed')
				continue
			}

			const previous = seen.get(exported.name)
			if (previous) {
				// Refuse both rather than let one win. A registry would warn and
				// overwrite; here the author has two files claiming one name and
				// picking either silently is the thing that hides the mistake.
				diagnostics.push({
					code: 'duplicate_tool_name',
					severity: 'error',
					message: `Two tools both call themselves "${exported.name}": ${previous} and ${file.relativePath}. Neither was registered.`,
					path: file.path,
				})
				record(file, 'tools', 'failed')
				continue
			}
			seen.set(exported.name, file.relativePath)
			tools.push({
				source: record(file, 'tools', 'loaded'),
				definition: exported,
			})
		}
	}

	// ─── skills ───────────────────────────────────────────────────────────
	if (included.includes('skills')) {
		const scan = await scanSlot(root, 'skills', 'skills')
		diagnostics.push(...scan.diagnostics)
		for (const file of scan.files) {
			try {
				// Delegated, not reimplemented. `Skill.dirPath` is required and
				// the prompt assembler renders `<location>{dirPath}/SKILL.md`,
				// so a flat `skills/*.md` would produce a skill the model is
				// told to read at a path that does not exist. Directory form is
				// the only form that survives to runtime.
				// `loadSkill` returns a result wrapper; the Skill is inside it.
				const { skill } = await loadSkill(file.path)
				skills.push({ source: record(file, 'skills', 'loaded'), skill })
			} catch (err) {
				diagnostics.push({
					code: 'skill_load_failed',
					severity: 'error',
					message: `${file.relativePath} is not a readable skill.`,
					path: file.path,
					cause: err instanceof Error ? err.message : String(err),
				})
				record(file, 'skills', 'failed')
			}
		}
	}

	// ─── agents (delegates) ───────────────────────────────────────────────
	if (included.includes('agents')) {
		const scan = await scanSlot(root, 'agents', 'agents')
		diagnostics.push(...scan.diagnostics)
		for (const entry of scan.files) {
			if (depth >= MAX_DEPTH) {
				diagnostics.push({
					code: 'subagent_too_deep',
					severity: 'warning',
					message:
						entry.relativePath +
						' was not loaded: a delegate may not declare delegates of its own.',
					path: entry.path,
				})
				record(entry, 'agents', 'skipped')
				continue
			}
			const child = await loadAt(entry.path, options, depth + 1)
			// The child's diagnostics are the parent's. A delegate that could
			// not load is a fact about THIS project, and a caller reading one
			// list should not have to walk the tree to find out the run will be
			// short a specialist.
			for (const d of child.diagnostics) {
				diagnostics.push({ ...d, message: entry.relativePath + ': ' + d.message })
			}
			if (!child.ok) {
				record(entry, 'agents', 'failed')
				continue
			}
			agents.push({
				source: record(entry, 'agents', 'loaded'),
				manifest: child.manifest,
				id: entry.id,
			})
		}
	}
	const name = config.name ?? basenameOf(root)

	return {
		manifest: {
			root,
			name,
			instructions,
			config,
			tools,
			skills,
			agents,
			sources,
			included,
			modules,
		},
		diagnostics,
		ok: diagnostics.every((d) => d.severity !== 'error'),
	}
}

/** Basename, with the filesystem root falling back to a usable label. */
function basenameOf(root: string): string {
	const parts = root.split(/[\\/]/).filter(Boolean)
	return parts[parts.length - 1] ?? 'agent'
}
