import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { namzuHomePath } from '../integrations/state/home.js'

/**
 * The person's one-time acknowledgements: that bypass mode runs everything,
 * and that they were told auto mode is the terminal's default.
 *
 * Kept in `~/.namzu/acknowledgements.json` beside the trusted-folder list: the
 * answer belongs to the person, not to a project or a conversation, and is
 * asked once. An unreadable file reads as "not acknowledged", so a damaged
 * record costs one more question (or one more notice) and never a skipped one.
 * Each write keeps the other keys the file holds.
 */

const FILE_MODE = 0o600
const DIR_MODE = 0o700
const VERSION = 1

interface AcknowledgementFile {
	readonly version: number
	readonly bypass?: string
	/** When the notice that auto mode is the terminal's default was shown. */
	readonly autoModeDefault?: string
}

type AcknowledgementKey = 'bypass' | 'autoModeDefault'

export function acknowledgementsPath(home?: string): string {
	return join(namzuHomePath(home), 'acknowledgements.json')
}

function read(path: string): AcknowledgementFile {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AcknowledgementFile>
		return {
			version: VERSION,
			...(typeof parsed.bypass === 'string' ? { bypass: parsed.bypass } : {}),
			...(typeof parsed.autoModeDefault === 'string'
				? { autoModeDefault: parsed.autoModeDefault }
				: {}),
		}
	} catch {
		return { version: VERSION }
	}
}

/** Record one acknowledgement (idempotent), written whole and atomically. */
function acknowledge(key: AcknowledgementKey, home: string | undefined, now: () => Date): void {
	const path = acknowledgementsPath(home)
	const current = read(path)
	if (current[key] !== undefined) return
	const next: AcknowledgementFile = { ...current, [key]: now().toISOString() }
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

/** Whether the person has already accepted what bypass mode does. */
export function hasAcknowledgedBypass(home?: string): boolean {
	return read(acknowledgementsPath(home)).bypass !== undefined
}

/** Record the acknowledgement (idempotent). A failure to write is reported, not hidden. */
export function acknowledgeBypass(home?: string, now: () => Date = () => new Date()): void {
	acknowledge('bypass', home, now)
}

/** Whether the person has already been told that auto mode is the terminal's default. */
export function hasSeenAutoModeDefaultNotice(home?: string): boolean {
	return read(acknowledgementsPath(home)).autoModeDefault !== undefined
}

/** Record that the notice was shown (idempotent). A failure to write is reported, not hidden. */
export function markAutoModeDefaultNoticeSeen(
	home?: string,
	now: () => Date = () => new Date(),
): void {
	acknowledge('autoModeDefault', home, now)
}

/**
 * The notice shown once, the first time a terminal starts in auto mode because
 * nothing chose another: a headline, then what the mode does and how to keep
 * being asked instead.
 */
export const AUTO_MODE_DEFAULT_NOTICE_TITLE = 'Auto mode is now Namzu’s default permission mode.'
export const AUTO_MODE_DEFAULT_NOTICE_BODY =
	'Before an action that would otherwise ask you, a second model checks it for risk and for instructions planted in what the agent read; what it judges safe runs, and the rest is stopped. Press Shift+Tab to change the mode, or set permissions.defaultMode: prompt in ~/.namzu/config.yaml to start by asking. See docs/cli/permission-modes.md.'

/** The words of the question, shared by the launch prompt and the in-terminal one. */
export const BYPASS_CONSENT_TITLE = 'Run without asking?'
export const BYPASS_CONSENT_BODY =
	'In bypass mode Namzu runs commands and edits files anywhere you can, without asking, including outside this folder. It still stops for removing a home or top-level folder, leaving a sandbox, rules that say deny or ask, and a short list of destructive commands. Only use it in a folder and on a machine you trust.'
