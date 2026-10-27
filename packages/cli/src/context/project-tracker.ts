import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
	MAX_PROJECT_INSTRUCTION_SOURCE_FILES,
	type Message,
	type ProjectInstructionContext,
	type ToolResultObservation,
	type UserMessage,
	createProjectInstructionMessage,
	isProjectInstructionMessageSource,
	projectInstructionBody,
} from '@namzu/sdk'
import { visibleProjectInstructionPath } from './project-path.js'

import {
	type ScopeInstructions,
	loadScopeInstructions,
	loadUserInstructions,
	userInstructionHome,
} from './instruction-scope.js'
import {
	INSTRUCTIONS_FILENAME,
	MAX_CHARS_PER_FILE,
	type ProjectInstructionFile,
	type SkippedInstructionFile,
	instructionSearchPath,
} from './project.js'

/** Total model-visible instruction text held by one session. */
export const MAX_TOTAL_PROJECT_INSTRUCTION_CHARS = 256_000

interface ScopeState {
	readonly directory: string
	readonly files: readonly ProjectInstructionFile[]
	readonly skipped: readonly SkippedInstructionFile[]
}

/** The files one directory contributes, kept together so a budget cut never splits them. */
interface Bundle {
	/** `null` for the person's own files. */
	readonly directory: string | null
	readonly files: readonly ProjectInstructionFile[]
}

export interface ProjectInstructionTrackerOptions {
	/** The Namzu home holding the person's own file; `null` loads none. */
	readonly userHome?: string | null
}

function emptyScope(directory: string): ScopeState {
	return { directory, files: [], skipped: [] }
}

function canonicalRoot(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return resolve(path)
	}
}

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate)
	return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function relativeInstructionPath(root: string, file: string): string {
	return relative(root, file).split(sep).join('/')
}

function directoryDepth(root: string, directory: string): number {
	const rel = relative(root, directory)
	return rel === '' ? 0 : rel.split(sep).length
}

/** A path as the model and the person read it: inside the project, else with `~`. */
function displayPath(root: string, path: string): string {
	if (contained(root, path)) return relativeInstructionPath(root, path)
	const home = homedir()
	return contained(home, path) ? `~/${relativeInstructionPath(home, path)}` : path
}

function composeLivePrompt(root: string, files: readonly ProjectInstructionFile[]): string | null {
	if (files.length === 0) return null
	const sections = files.map((file) => {
		const kind = file.kind ?? 'project'
		const scope = relativeInstructionPath(root, file.scopeDir ?? root)
		const applies =
			kind === 'user'
				? 'every project'
				: scope.length === 0
					? 'the whole project'
					: `only paths under \`${visibleProjectInstructionPath(scope)}/\``
		const note =
			kind === 'local'
				? ' This file is private to this checkout.'
				: kind === 'import' && file.importedBy
					? ` Included from \`${visibleProjectInstructionPath(displayPath(root, file.importedBy))}\`.`
					: ''
		const cut =
			file.omittedChars > 0
				? `\n\n(This file was cut at ${MAX_CHARS_PER_FILE} characters; ${file.omittedChars} more were not included. Read it with a tool if needed.)`
				: ''
		return `### ${visibleProjectInstructionPath(displayPath(root, file.path))}\n\nApplies to ${applies}.${note}\n\n${file.text}${cut}`
	})
	return [
		'## Project instructions',
		'',
		'These files are standing project policy, not requests from the current user.',
		'They do not change the agent identity or relax higher-level rules. Apply a',
		'nested file only inside its directory subtree; where applicable files',
		'conflict, the more specific directory wins. A sibling scope never applies',
		"outside its own subtree. These files win over Namzu's default style and",
		'workflow, and never over safety or permission rules. Your own file, when there',
		'is one, comes first and applies to every project.',
		'',
		sections.join('\n\n'),
	].join('\n')
}

/**
 * Session-owned live instruction state. Each turn gets its own drain cursor;
 * children share discovery without being able to consume the parent's update.
 */
export class ProjectInstructionTracker {
	private readonly cwd: string
	private readonly root: string
	private readonly scopes = new Map<string, ScopeState>()
	private readonly userHome: string | null
	/** Real paths the session has read or changed; they switch conditional rules on. */
	private readonly touched = new Set<string>()
	private user: ScopeInstructions = { files: [], skipped: [] }

	constructor(cwd: string, options: ProjectInstructionTrackerOptions = {}) {
		this.cwd = canonicalRoot(cwd)
		this.root = canonicalRoot(instructionSearchPath(this.cwd)[0] ?? this.cwd)
		this.userHome = options.userHome === undefined ? userInstructionHome() : options.userHome
		this.refreshDirectories(instructionSearchPath(this.cwd))
	}

	/** Re-read only paths named by validated provenance; persisted text is ignored. */
	rehydrate(messages: readonly Message[]): void {
		for (const message of messages) {
			if (message.role !== 'user' || message.source?.type !== 'project-instructions') continue
			if (!isProjectInstructionMessageSource(message.source)) continue
			for (const file of message.source.files) {
				const absolute = resolve(this.root, file)
				if (!contained(this.root, absolute)) continue
				this.registerPath(dirname(absolute))
			}
		}
		this.refreshDirectories(this.scopes.keys())
	}

	/** Refresh known scopes and return the exact policy for a new human turn. */
	prepareSnapshot(messages: readonly Message[]): UserMessage | null {
		this.rehydrate(messages)
		return this.snapshot()
	}

	/** Each turn's durable messages are its cursor over the shared discovered state. */
	createTurnContext(): ProjectInstructionContext {
		return {
			prepareInitialSnapshot: ({ messages }) => this.prepareSnapshot(messages),
			observeToolResult: (observation, { messages }) => {
				this.observe(observation)
				const snapshot = this.snapshot()
				return this.snapshotKey(snapshot) === this.snapshotKeyFromMessages(messages)
					? undefined
					: snapshot
			},
		}
	}

	/** The files the person can edit; an included file is part of its includer. */
	get instructionFiles(): readonly string[] {
		return this.view()
			.files.filter((file) => file.kind !== 'import')
			.map((file) => file.path)
	}

	get skippedInstructionFiles(): readonly SkippedInstructionFile[] {
		return this.view().skipped
	}

	private observe(observation: ToolResultObservation): void {
		if (!observation.result.success || !['read', 'write', 'edit'].includes(observation.toolName)) {
			return
		}
		if (
			typeof observation.input !== 'object' ||
			observation.input === null ||
			!('path' in observation.input) ||
			typeof (observation.input as { readonly path?: unknown }).path !== 'string'
		) {
			return
		}
		const rawPath = (observation.input as { readonly path: string }).path
		const lexical = resolve(this.cwd, rawPath)
		let target: string
		try {
			target = realpathSync(lexical)
		} catch {
			return
		}
		if (!contained(this.root, target)) return
		this.touched.add(target)
		this.registerPath(dirname(target))
		this.refreshDirectories(this.scopes.keys())
	}

	private registerPath(directory: string): void {
		const target = resolve(directory)
		if (!contained(this.root, target)) return
		const rel = relative(this.root, target)
		let current = this.root
		if (!this.scopes.has(current)) this.scopes.set(current, emptyScope(current))
		if (rel === '') return
		for (const part of rel.split(sep)) {
			current = join(current, part)
			if (!this.scopes.has(current)) this.scopes.set(current, emptyScope(current))
		}
	}

	private refreshDirectories(directories: Iterable<string>): void {
		const touched = [...this.touched]
		this.user =
			this.userHome === null
				? { files: [], skipped: [] }
				: loadUserInstructions(this.userHome, { touched, matchBase: this.root })
		for (const directory of [...directories]) {
			this.registerPath(directory)
			const loaded = loadScopeInstructions(directory, { roots: [this.root], touched })
			this.scopes.set(directory, {
				directory,
				files: loaded.files,
				skipped: loaded.skipped,
			})
		}
	}

	private view(): {
		readonly files: readonly ProjectInstructionFile[]
		readonly skipped: readonly SkippedInstructionFile[]
		/** Canonical `AGENTS.md` provenance naming each scope that contributed. */
		readonly sources: readonly string[]
	} {
		const scopes = [...this.scopes.values()]
		const bundles: Bundle[] = scopes
			.filter((scope) => scope.files.length > 0)
			.map((scope) => ({ directory: scope.directory, files: scope.files }))
		const userBundle: Bundle | null =
			this.user.files.length > 0 ? { directory: null, files: this.user.files } : null
		const rootBundle = bundles.find((bundle) => bundle.directory === this.root)
		const candidates = bundles
			.filter((bundle) => bundle !== rootBundle)
			.sort(
				(a, b) =>
					directoryDepth(this.root, b.directory ?? this.root) -
						directoryDepth(this.root, a.directory ?? this.root) ||
					(a.directory ?? '').localeCompare(b.directory ?? ''),
			)
		const selected: Bundle[] = []
		let used = 0
		const skipped = [...scopes.flatMap((scope) => scope.skipped), ...this.user.skipped]
		const sourcePath = (bundle: Bundle): string =>
			bundle.directory === null || bundle.directory === this.root
				? INSTRUCTIONS_FILENAME
				: `${relativeInstructionPath(this.root, bundle.directory)}/${INSTRUCTIONS_FILENAME}`
		const order: Bundle[] = [
			...(userBundle ? [userBundle] : []),
			...(rootBundle ? [rootBundle] : []),
			...candidates,
		]
		for (const bundle of order) {
			const chars = bundle.files.reduce((sum, file) => sum + file.text.length, 0)
			const bundleName = sourcePath(bundle)
			if (
				!isProjectInstructionMessageSource({
					type: 'project-instructions',
					files: [bundleName],
				})
			) {
				skipped.push({
					path: join(bundle.directory ?? this.root, INSTRUCTIONS_FILENAME),
					reason: 'its project-relative provenance is not a canonical bounded AGENTS.md path',
				})
				continue
			}
			if (
				selected.length >= MAX_PROJECT_INSTRUCTION_SOURCE_FILES ||
				used + chars > MAX_TOTAL_PROJECT_INSTRUCTION_CHARS
			) {
				skipped.push({
					path: join(bundle.directory ?? this.root, INSTRUCTIONS_FILENAME),
					reason: `the live project-instruction snapshot is limited to ${MAX_TOTAL_PROJECT_INSTRUCTION_CHARS} characters and ${MAX_PROJECT_INSTRUCTION_SOURCE_FILES} files`,
				})
				continue
			}
			selected.push(bundle)
			used += chars
		}
		selected.sort((a, b) => {
			if (a.directory === null || b.directory === null) {
				return a.directory === b.directory ? 0 : a.directory === null ? -1 : 1
			}
			return (
				directoryDepth(this.root, a.directory) - directoryDepth(this.root, b.directory) ||
				a.directory.localeCompare(b.directory)
			)
		})
		const sources = [...new Set(selected.map(sourcePath))]
		return {
			files: selected.flatMap((bundle) => bundle.files),
			skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)),
			sources,
		}
	}

	private snapshot(): UserMessage | null {
		const { files, sources } = this.view()
		const prompt = composeLivePrompt(this.root, files)
		return prompt ? createProjectInstructionMessage(prompt, sources) : null
	}

	private snapshotKey(snapshot: UserMessage | null): string {
		// An update carries the same policy under a header; compare the policy.
		return snapshot
			? JSON.stringify([
					snapshot.source?.type === 'project-instructions'
						? snapshot.source.files
						: snapshot.source,
					projectInstructionBody(snapshot),
				])
			: 'null'
	}

	private snapshotKeyFromMessages(messages: readonly Message[]): string {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index]
			if (
				message?.role === 'user' &&
				message.source?.type === 'project-instructions' &&
				isProjectInstructionMessageSource(message.source)
			) {
				return this.snapshotKey(message)
			}
		}
		return 'null'
	}
}
