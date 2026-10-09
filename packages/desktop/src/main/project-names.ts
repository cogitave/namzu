import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The longest display name a person can give a project. */
export const PROJECT_NAME_LIMIT = 80

/** Why a project name was refused, in words for the person; undefined when it is fine. */
export function projectNameProblem(name: string): string | undefined {
	const trimmed = name.trim()
	if (trimmed.length === 0) return 'Give the project a name.'
	if (trimmed.length > PROJECT_NAME_LIMIT)
		return `Use ${PROJECT_NAME_LIMIT} characters or fewer for the name.`
	for (const char of trimmed) {
		const code = char.codePointAt(0) ?? 0
		if (code < 0x20 || code === 0x7f) return 'The name cannot contain control characters.'
	}
	return undefined
}

/**
 * The names people gave their projects, keyed by folder path. A name changes what Namzu shows,
 * never the folder on disk. A missing or unreadable file means every project shows its folder name.
 */
export class ProjectNameStore {
	private readonly names = new Map<string, string>()
	constructor(private readonly file: string) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
				for (const [path, name] of Object.entries(parsed))
					if (typeof name === 'string' && !projectNameProblem(name)) this.names.set(path, name)
		} catch {
			// A first run has no file yet; a damaged one is replaced by the next rename.
		}
	}
	get(path: string): string | undefined {
		return this.names.get(path)
	}
	/** Sets the name, or clears it when `name` is undefined so the folder name shows again. */
	set(path: string, name: string | undefined): void {
		if (name === undefined) this.names.delete(path)
		else this.names.set(path, name)
		mkdirSync(dirname(this.file), { recursive: true })
		writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.names)), {
			mode: 0o600,
		})
		renameSync(`${this.file}.tmp`, this.file)
	}
}
