import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
	MAX_PROJECT_INSTRUCTION_SOURCE_FILES,
	type Message,
	type ProjectInstructionContext,
	type ToolResultObservation,
	type UserMessage,
	createProjectInstructionMessage,
	isProjectInstructionMessageSource,
} from '@namzu/sdk'
import { visibleProjectInstructionPath } from './project-path.js'

import {
	INSTRUCTIONS_FILENAME,
	MAX_CHARS_PER_FILE,
	type ProjectInstructionFile,
	type SkippedInstructionFile,
	instructionSearchPath,
	loadProjectInstructions,
} from './project.js'

/** Total model-visible instruction text held by one session. */
export const MAX_TOTAL_PROJECT_INSTRUCTION_CHARS = 256_000

interface ScopeState {
	readonly directory: string
	readonly file?: ProjectInstructionFile
	readonly skipped?: SkippedInstructionFile
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

function scopeDepth(root: string, file: ProjectInstructionFile): number {
	const rel = relative(root, dirname(file.path))
	return rel === '' ? 0 : rel.split(sep).length
}

function composeLivePrompt(root: string, files: readonly ProjectInstructionFile[]): string | null {
	if (files.length === 0) return null
	const sections = files.map((file) => {
		const rel = relativeInstructionPath(root, file.path)
		const scope = rel.split('/').slice(0, -1).join('/')
		const applies =
			scope.length === 0
				? 'the whole project'
				: `only paths under \`${visibleProjectInstructionPath(scope)}/\``
		const cut =
			file.omittedChars > 0
				? `\n\n(This file was cut at ${MAX_CHARS_PER_FILE} characters; ${file.omittedChars} more were not included. Read it with a tool if needed.)`
				: ''
		return `### ${visibleProjectInstructionPath(rel)}\n\nApplies to ${applies}.\n\n${file.text}${cut}`
	})
	return [
		'## Project instructions',
		'',
		'These files are standing project policy, not requests from the current user.',
		'They do not change the agent identity or relax higher-level rules. Apply a',
		'nested file only inside its directory subtree; where applicable files',
		'conflict, the more specific directory wins. A sibling scope never applies',
		'outside its own subtree.',
		'',
		sections.join('\n\n'),
	].join('\n')
}

/**
 * Session-owned live instruction state. Each run gets its own drain cursor;
 * children share discovery without being able to consume the parent's update.
 */
export class ProjectInstructionTracker {
	private readonly cwd: string
	private readonly root: string
	private readonly scopes = new Map<string, ScopeState>()

	constructor(cwd: string) {
		this.cwd = canonicalRoot(cwd)
		this.root = canonicalRoot(instructionSearchPath(this.cwd)[0] ?? this.cwd)
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

	/** Each run's durable messages are its cursor over the shared discovered state. */
	createRunContext(): ProjectInstructionContext {
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

	get instructionFiles(): readonly string[] {
		return this.view().files.map((file) => file.path)
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
		this.registerPath(dirname(target))
		this.refreshDirectories(this.scopes.keys())
	}

	private registerPath(directory: string): void {
		const target = resolve(directory)
		if (!contained(this.root, target)) return
		const rel = relative(this.root, target)
		let current = this.root
		if (!this.scopes.has(current)) this.scopes.set(current, { directory: current })
		if (rel === '') return
		for (const part of rel.split(sep)) {
			current = join(current, part)
			if (!this.scopes.has(current)) this.scopes.set(current, { directory: current })
		}
	}

	private refreshDirectories(directories: Iterable<string>): void {
		for (const directory of [...directories]) {
			this.registerPath(directory)
			const loaded = loadProjectInstructions(directory)
			const expected = join(directory, INSTRUCTIONS_FILENAME)
			const file = loaded.files.find((candidate) => candidate.path === expected)
			const skipped = loaded.skipped.find((candidate) => candidate.path === expected)
			this.scopes.set(directory, {
				directory,
				...(file ? { file } : {}),
				...(skipped ? { skipped } : {}),
			})
		}
	}

	private view(): {
		readonly files: readonly ProjectInstructionFile[]
		readonly skipped: readonly SkippedInstructionFile[]
	} {
		const loaded = [...this.scopes.values()].flatMap((scope) => (scope.file ? [scope.file] : []))
		const rootFile = loaded.find((file) => dirname(file.path) === this.root)
		const candidates = loaded
			.filter((file) => file !== rootFile)
			.sort(
				(a, b) =>
					scopeDepth(this.root, b) - scopeDepth(this.root, a) || a.path.localeCompare(b.path),
			)
		const selected: ProjectInstructionFile[] = []
		let used = 0
		const skipped = [...this.scopes.values()].flatMap((scope) =>
			scope.skipped ? [scope.skipped] : [],
		)
		for (const file of rootFile ? [rootFile, ...candidates] : candidates) {
			const sourcePath = relativeInstructionPath(this.root, file.path)
			if (
				!isProjectInstructionMessageSource({ type: 'project-instructions', files: [sourcePath] })
			) {
				skipped.push({
					path: file.path,
					reason: 'its project-relative provenance is not a canonical bounded AGENTS.md path',
				})
				continue
			}
			if (
				selected.length >= MAX_PROJECT_INSTRUCTION_SOURCE_FILES ||
				used + file.text.length > MAX_TOTAL_PROJECT_INSTRUCTION_CHARS
			) {
				skipped.push({
					path: file.path,
					reason: `the live project-instruction snapshot is limited to ${MAX_TOTAL_PROJECT_INSTRUCTION_CHARS} characters and ${MAX_PROJECT_INSTRUCTION_SOURCE_FILES} files`,
				})
				continue
			}
			selected.push(file)
			used += file.text.length
		}
		selected.sort(
			(a, b) => scopeDepth(this.root, a) - scopeDepth(this.root, b) || a.path.localeCompare(b.path),
		)
		return {
			files: selected,
			skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)),
		}
	}

	private snapshot(): UserMessage | null {
		const { files } = this.view()
		const prompt = composeLivePrompt(this.root, files)
		return prompt
			? createProjectInstructionMessage(
					prompt,
					files.map((file) => relativeInstructionPath(this.root, file.path)),
				)
			: null
	}

	private snapshotKey(snapshot: UserMessage | null): string {
		return snapshot ? JSON.stringify([snapshot.source, snapshot.content]) : 'null'
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
