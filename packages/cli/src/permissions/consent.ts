import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { namzuHomePath } from '../integrations/state/home.js'

/**
 * The person's one-time acknowledgement that bypass mode runs everything.
 *
 * Kept in `~/.namzu/acknowledgements.json` beside the trusted-folder list: the
 * answer belongs to the person, not to a project or a conversation, and is
 * asked once. An unreadable file reads as "not acknowledged", so a damaged
 * record costs one more question and never a skipped one.
 */

const FILE_MODE = 0o600
const DIR_MODE = 0o700
const VERSION = 1

interface AcknowledgementFile {
	readonly version: number
	readonly bypass?: string
}

export function acknowledgementsPath(home?: string): string {
	return join(namzuHomePath(home), 'acknowledgements.json')
}

function read(path: string): AcknowledgementFile {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AcknowledgementFile>
		return {
			version: VERSION,
			...(typeof parsed.bypass === 'string' ? { bypass: parsed.bypass } : {}),
		}
	} catch {
		return { version: VERSION }
	}
}

/** Whether the person has already accepted what bypass mode does. */
export function hasAcknowledgedBypass(home?: string): boolean {
	return read(acknowledgementsPath(home)).bypass !== undefined
}

/** Record the acknowledgement (idempotent). A failure to write is reported, not hidden. */
export function acknowledgeBypass(home?: string, now: () => Date = () => new Date()): void {
	const path = acknowledgementsPath(home)
	const current = read(path)
	if (current.bypass !== undefined) return
	const next: AcknowledgementFile = { ...current, bypass: now().toISOString() }
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	const temp = `${path}.${randomUUID()}.tmp`
	try {
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: FILE_MODE })
		renameSync(temp, path)
	} catch (error) {
		rmSync(temp, { force: true })
		throw error
	}
}

/** The words of the question, shared by the launch prompt and the in-terminal one. */
export const BYPASS_CONSENT_TITLE = 'Run without asking?'
export const BYPASS_CONSENT_BODY =
	'In bypass mode Namzu runs commands and edits files anywhere you can, without asking, including outside this folder. It still stops for removing a home or top-level folder, leaving a sandbox, rules that say deny or ask, and a short list of destructive commands. Only use it in a folder and on a machine you trust.'
