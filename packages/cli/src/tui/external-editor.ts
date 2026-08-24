import { spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_EDITED_DRAFT_BYTES = 4 * 1024 * 1024

export class ExternalEditorError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ExternalEditorError'
	}
}

/**
 * Split the operator-owned VISUAL/EDITOR value without invoking a shell.
 *
 * Quotes admit executable paths and arguments with spaces. A backslash only
 * escapes syntax that needs escaping, so an ordinary Windows path does not
 * lose every separator when the same configuration is used across shells.
 */
export function parseExternalEditorCommand(raw: string): readonly string[] {
	const result: string[] = []
	let token = ''
	let tokenStarted = false
	let quote: 'single' | 'double' | null = null

	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index] ?? ''
		if (quote === 'single') {
			if (char === "'") quote = null
			else token += char
			continue
		}
		if (quote === 'double') {
			if (char === '"') {
				quote = null
				continue
			}
			if (char === '\\') {
				const next = raw[index + 1]
				if (next === '"' || next === '\\') {
					token += next
					index += 1
					continue
				}
			}
			token += char
			continue
		}
		if (/\s/u.test(char)) {
			if (tokenStarted) {
				result.push(token)
				token = ''
				tokenStarted = false
			}
			continue
		}
		if (char === "'") {
			quote = 'single'
			tokenStarted = true
			continue
		}
		if (char === '"') {
			quote = 'double'
			tokenStarted = true
			continue
		}
		if (char === '\\') {
			const next = raw[index + 1]
			if (
				next !== undefined &&
				(/\s/u.test(next) || next === '"' || next === "'" || next === '\\')
			) {
				token += next
				tokenStarted = true
				index += 1
				continue
			}
		}
		token += char
		tokenStarted = true
	}

	if (quote) throw new ExternalEditorError('the editor command contains an unclosed quote')
	if (tokenStarted) result.push(token)
	if (!result[0]) throw new ExternalEditorError('neither VISUAL nor EDITOR names an executable')
	return result
}

export function resolveExternalEditorCommand(
	env: Readonly<NodeJS.ProcessEnv> = process.env,
): readonly string[] {
	const visual = env.VISUAL?.trim()
	const editor = env.EDITOR?.trim()
	const raw = visual || editor
	if (!raw) throw new ExternalEditorError('set VISUAL or EDITOR before pressing Ctrl+G')
	return parseExternalEditorCommand(raw)
}

export interface ExternalEditorOptions {
	readonly cwd: string
	readonly env?: Readonly<NodeJS.ProcessEnv>
	readonly signal?: AbortSignal
	readonly temporaryRoot?: string
}

/**
 * Run the operator's configured editor against a private temporary Markdown
 * file and return the edited text. This is a direct host action explicitly
 * requested by the operator; it is never exposed to the model as a tool.
 */
export async function editDraftInExternalEditor(
	seed: string,
	options: ExternalEditorOptions,
): Promise<string> {
	options.signal?.throwIfAborted()
	const command = resolveExternalEditorCommand(options.env)
	const directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), 'namzu-editor-'))
	const draftPath = join(directory, 'draft.md')
	let edited: string | undefined
	let failure: unknown
	try {
		await writeFile(draftPath, seed, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
		await runEditorProcess(command, draftPath, options)
		const metadata = await lstat(draftPath)
		if (!metadata.isFile()) {
			throw new ExternalEditorError('the editor replaced the draft with a non-file')
		}
		const size = metadata.size
		if (size > MAX_EDITED_DRAFT_BYTES) {
			throw new ExternalEditorError(
				`the edited draft is ${size.toLocaleString()} bytes; the limit is ${MAX_EDITED_DRAFT_BYTES.toLocaleString()}`,
			)
		}
		edited = await readFile(draftPath, 'utf8')
	} catch (error) {
		failure = error
	}
	try {
		await rm(directory, {
			force: true,
			recursive: true,
			maxRetries: 5,
			retryDelay: 50,
		})
	} catch {
		throw new ExternalEditorError('could not remove the private temporary editor buffer')
	}
	if (failure !== undefined) throw failure
	return edited ?? ''
}

async function runEditorProcess(
	command: readonly string[],
	draftPath: string,
	options: ExternalEditorOptions,
): Promise<void> {
	const executable = command[0]
	if (!executable) throw new ExternalEditorError('the editor command is empty')
	await new Promise<void>((resolve, reject) => {
		let settled = false
		const settle = (action: () => void) => {
			if (settled) return
			settled = true
			action()
		}
		const child = spawn(executable, [...command.slice(1), draftPath], {
			cwd: options.cwd,
			env: options.env ? { ...options.env } : process.env,
			signal: options.signal,
			stdio: 'inherit',
			windowsHide: false,
		})
		child.once('error', (error) =>
			settle(() => reject(new ExternalEditorError(`could not start the editor: ${error.message}`))),
		)
		child.once('exit', (code, signal) =>
			settle(() => {
				if (code === 0) resolve()
				else if (signal) reject(new ExternalEditorError(`the editor stopped on signal ${signal}`))
				else reject(new ExternalEditorError(`the editor exited with status ${code ?? 'unknown'}`))
			}),
		)
	})
}
