import type { AgentIdentity, RunAgentOptions } from '../agents/runAgent.js'
import type { Message } from '../types/message/index.js'
import type { LLMProvider } from '../types/provider/index.js'
import type { Skill } from '../types/skills/index.js'
import type { ToolDefinition } from '../types/tool/index.js'

/**
 * A directory in the convention this package reads.
 *
 * `channels/` and `schedules/` are deliberately absent. They were scoped in
 * and then cut: a trigger definition of `{id, handler}` cannot express a
 * signed webhook, because signature verification needs the RAW body and a
 * handler that receives a parsed one can never check an HMAC. It carries no
 * idempotency key either, while webhooks retry and schedules double-fire, and
 * a cron field with no timezone story is a declaration nothing drives. Each of
 * those is a `major` waiting to happen on a published type. The layering
 * question — does a convention belong outside the kernel — was answered yes
 * and stands; the shape question had simply never been asked.
 */
export type DirectorySlot = 'agent' | 'instructions' | 'tools' | 'skills' | 'agents'

export const ALL_SLOTS: readonly DirectorySlot[] = [
	'agent',
	'instructions',
	'tools',
	'skills',
	'agents',
]

/**
 * Whether the loader executes the project's code.
 *
 * `'evaluate'` imports every module-backed file, and importing a module RUNS
 * it — a top-level side effect in `tools/search.ts` happens during
 * `loadDirectory`, in this process, with this process's privileges.
 *
 * `'skip'` imports nothing. The manifest still carries the full structural
 * truth — every path, the instructions, the skills, duplicate and ambiguity
 * detection — and module-backed entries report `'not_loaded'`. This is what a
 * CI gate, a UI file tree, and triage of a directory you did not write all
 * actually want, and it is the only mode that is safe against a directory
 * whose author you are not.
 */
export type ModuleMode = 'evaluate' | 'skip'

export type ModuleImporter = (fileUrl: string) => Promise<unknown>

export type SourceOutcome =
	| 'loaded'
	| 'failed'
	/** Refused, or not a code file. Carries a diagnostic unless `.`/`_`-prefixed. */
	| 'skipped'
	/** `modules: 'skip'` — never imported, so nothing is known about its exports. */
	| 'not_loaded'
	/**
	 * The import outran `moduleTimeoutMs`.
	 *
	 * NOT a synonym for `'failed'`. `import()` cannot be cancelled: the module
	 * is still executing, may still complete, and its top-level side effects
	 * may land after `loadDirectory` has returned. Node then caches it, so a
	 * second load in the same process can see the same file succeed instantly.
	 * A distinct outcome because "we stopped waiting" and "it did not work"
	 * lead a reader to different places.
	 */
	| 'abandoned'

export interface SourceRef {
	/** Absolute and canonical — symlinks already resolved. */
	readonly path: string
	/** Posix, relative to the project root: `tools/search.ts`. */
	readonly relativePath: string
	readonly slot: DirectorySlot
	/** Path-derived, extension stripped. `tools/search.ts` → `search`. */
	readonly id: string
	readonly outcome: SourceOutcome
}

export type DirectoryDiagnosticSeverity = 'error' | 'warning'

export type DirectoryDiagnosticCode =
	| 'instructions_missing'
	| 'instructions_empty'
	| 'module_load_failed'
	| 'module_load_abandoned'
	| 'no_default_export'
	| 'not_a_tool'
	| 'duplicate_tool_name'
	| 'invalid_config'
	| 'skill_load_failed'
	| 'symlink_refused'
	| 'path_escapes_root'
	| 'unscanned_directory'
	| 'root_missing'
	| 'subagent_load_failed'
	| 'subagent_too_deep'

/**
 * Something the loader could not do, reported rather than dropped.
 *
 * A loader that quietly skips a broken tool produces a project running with
 * half its capabilities and nothing to say so. Every refusal names its file
 * and its reason, and an inspector can render the list without re-reading the
 * directory.
 */
export interface DirectoryDiagnostic {
	readonly code: DirectoryDiagnosticCode
	readonly severity: DirectoryDiagnosticSeverity
	readonly message: string
	/** Absolute path, when the diagnostic is about a file. */
	readonly path?: string
	/**
	 * The underlying error's message, when there was one.
	 *
	 * This package never reads file CONTENTS into a diagnostic. What appears
	 * here is text produced by Node or thrown by the authored module, and is
	 * exactly as trustworthy as that module — a `throw new Error(secret)` puts
	 * the secret here, and no amount of redaction on our side changes that.
	 */
	readonly cause?: string
}

export interface ToolEntry {
	readonly source: SourceRef
	readonly definition: ToolDefinition
}

/**
 * A delegate this project declares, loaded as a project in its own right.
 *
 * Recursion rather than a new concept: a sub-agent directory has the same
 * shape as its parent, so `agents/researcher/` is read by the same loader
 * that read the root. One level only — a delegate may not declare delegates of its
 * own in this version. Unbounded nesting is a topology decision (who may
 * spawn whom, and how deep) that belongs to whoever composes the system, and
 * shipping it before that decision means shipping a default nobody chose.
 */
export interface SubAgentEntry {
	readonly source: SourceRef
	/** The delegate's own manifest — its instructions, tools and config. */
	readonly manifest: DirectoryManifest
	/** Directory-derived, and the id a supervisor delegates to. */
	readonly id: string
}

export interface SkillEntry {
	readonly source: SourceRef
	readonly skill: Skill
}

/**
 * What `agent.ts` may declare.
 *
 * Deliberately a plain object, default-exported, with no authoring helper. A
 * `defineAgent` here would collide with the SDK's existing export of that
 * name, and `export default { model: 'x' } satisfies DirectoryConfig` already
 * gets the type checking a helper would provide.
 *
 * There is no factory form. It would buy environment-conditioned config that
 * `model: process.env.MODEL` already does inside a module that is being
 * evaluated anyway, and it would cost a user-function-invocation phase with a
 * hang mode outside what `moduleTimeoutMs` promises to bound.
 */
export interface DirectoryConfig {
	readonly model?: string
	readonly temperature?: number
	readonly maxIterations?: number
	readonly tokenBudget?: number
	readonly timeoutMs?: number
	/** Maximum provider-stream silence in milliseconds; `0` disables the bound. */
	readonly streamIdleTimeoutMs?: number
	/** Names the agent in traces and events when declared. */
	readonly name?: string
	/** Free-form labels for an inspector. Never interpreted by this package. */
	readonly metadata?: Readonly<Record<string, string>>
}

export interface DirectoryManifest {
	/** Absolute, canonical path to the `agent/` directory. */
	readonly root: string
	/**
	 * A DISPLAY LABEL — `config.name`, else the directory's basename, else
	 * `'agent'`.
	 *
	 * Not a trace key, and `deriveRunOptions` forwards it to `runAgent` only
	 * when `agent.ts` declared one. A name guessed from a directory basename
	 * would collide across sibling projects and silently merge their traces,
	 * which is worse than the SDK's own default.
	 */
	readonly name: string
	/** Verbatim `instructions.md`, trailing whitespace removed. */
	readonly instructions: string
	readonly config: DirectoryConfig
	readonly tools: readonly ToolEntry[]
	readonly skills: readonly SkillEntry[]
	/** Delegates this project declares. Empty unless it has an `agents/` slot. */
	readonly agents: readonly SubAgentEntry[]
	/** Every file considered, with its outcome. An inspector's ground truth. */
	readonly sources: readonly SourceRef[]
	/** Which slots were scanned. What `ok` is scoped to. */
	readonly included: readonly DirectorySlot[]
	readonly modules: ModuleMode
}

export interface DirectoryLoadResult {
	readonly manifest: DirectoryManifest
	readonly diagnostics: readonly DirectoryDiagnostic[]
	/**
	 * True when no diagnostic is an error.
	 *
	 * Scoped to `manifest.included`: it means "every slot you asked for is
	 * sound", never "this directory is complete". A caller that scanned only
	 * `tools` learns nothing here about `instructions`.
	 */
	readonly ok: boolean
}

export interface LoadDirectoryOptions {
	/** See {@link ModuleMode}. Default `'evaluate'`. */
	readonly modules?: ModuleMode
	/**
	 * Replace the import.
	 *
	 * The exit for a project Node's own type stripping cannot read — enums,
	 * decorators, tsconfig path aliases — where a host passes `jiti.import` or
	 * a `tsx`-registered importer. Three lines in the host, and no bundler
	 * dependency in this tree; the same rule `LLMProvider` follows.
	 *
	 * Ignored under `modules: 'skip'`, where nothing is imported at all.
	 */
	readonly importModule?: ModuleImporter
	/**
	 * Slots to scan. Default: all of them.
	 *
	 * The tuple type makes an empty array unrepresentable in TypeScript on
	 * purpose. This is an allow-list, and an allow-list that admits everything
	 * when empty is the fail-open shape this estate removed elsewhere; here an
	 * empty list scans nothing, which is the closed reading.
	 */
	readonly include?: readonly [DirectorySlot, ...DirectorySlot[]]
	/**
	 * Per-module deadline. Default 10_000ms.
	 *
	 * Bounds THIS LOADER, not the module. An import that expires is not
	 * cancelled — see {@link SourceOutcome} `'abandoned'`.
	 */
	readonly moduleTimeoutMs?: number
}

export interface DeriveRunOptionsInput {
	readonly provider: LLMProvider
	readonly prompt: string | Message[]
	/** Wins over `agent.ts`. Required when `agent.ts` names no model. */
	readonly model?: string
	readonly identity?: AgentIdentity
	readonly overrides?: Partial<Omit<RunAgentOptions, 'provider' | 'prompt'>>
}
