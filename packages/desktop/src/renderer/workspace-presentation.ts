import type { ComputerChatLayout } from './computer-chat-motion.js'

export type WorkDisclosureChoices = Record<string, boolean>
const maxWorkDisclosures = 32
const maxWorkDisclosureKeyLength = 96
const maxWorkDisclosuresSerializedLength = 3072

/** The turn and first admitted public entry distinguish segments after live steering. */
export function workDisclosureKey(turn: number, firstEntryKey: string): string | undefined {
	if (!Number.isSafeInteger(turn) || turn < 0 || !firstEntryKey) return undefined
	const key = JSON.stringify([turn, firstEntryKey])
	return key.length <= maxWorkDisclosureKeyLength ? key : undefined
}

export function chooseWorkDisclosure(
	choices: WorkDisclosureChoices,
	key: string,
	open: boolean,
): WorkDisclosureChoices {
	if (!validWorkDisclosureKey(key)) return choices
	const entries = [
		...Object.entries(choices).filter(([existing]) => existing !== key),
		[key, open] as const,
	].slice(-maxWorkDisclosures)
	while (
		entries.length &&
		JSON.stringify(Object.fromEntries(entries)).length > maxWorkDisclosuresSerializedLength
	)
		entries.shift()
	return Object.fromEntries(entries)
}

function validWorkDisclosureKey(key: string): boolean {
	if (!key || key.length > maxWorkDisclosureKeyLength) return false
	try {
		const parsed = JSON.parse(key) as unknown
		return (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			typeof parsed[0] === 'number' &&
			typeof parsed[1] === 'string' &&
			workDisclosureKey(parsed[0], parsed[1]) === key
		)
	} catch {
		return false
	}
}

function validWorkDisclosures(value: unknown): value is WorkDisclosureChoices {
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length <= maxWorkDisclosures &&
		JSON.stringify(value).length <= maxWorkDisclosuresSerializedLength &&
		Object.entries(value).every(
			([key, open]) => validWorkDisclosureKey(key) && typeof open === 'boolean',
		)
	)
}

export interface WorkspacePresentation {
	palScreen?: { palId: string; activeTab: 'chat' | 'computer' }
	computerChat: ComputerChatLayout
	floatingChatMinimized: boolean
	palProfileOpen: boolean
	computerProfileOpen: boolean
	jobsOpen: boolean
	panelTab: 'jobs' | 'changes'
	follow: boolean
	scrollTop: number
	/** Only explicit operator choices; an absent entry retains live/settled defaults. */
	workDisclosures?: WorkDisclosureChoices
}
const key = (id: string) => `namzu.workspace.presentation:${id}`

/** This is view state; drafts, approvals and runtime processes remain owned by main. */
export function readWorkspacePresentation(
	storage: Pick<Storage, 'getItem'>,
	id: string,
	palId?: string,
): WorkspacePresentation | null {
	try {
		const raw = storage.getItem(key(id))
		if (!raw || raw.length > 4096) return null
		const value = JSON.parse(raw) as Record<string, unknown>
		if (
			!value ||
			typeof value !== 'object' ||
			Array.isArray(value) ||
			typeof value.computerChat !== 'string' ||
			!['hidden', 'floating', 'split'].includes(value.computerChat) ||
			typeof value.panelTab !== 'string' ||
			!['jobs', 'changes'].includes(value.panelTab) ||
			![
				'floatingChatMinimized',
				'palProfileOpen',
				'computerProfileOpen',
				'jobsOpen',
				'follow',
			].every((field) => typeof value[field] === 'boolean') ||
			typeof value.scrollTop !== 'number' ||
			!Number.isFinite(value.scrollTop) ||
			value.scrollTop < 0 ||
			(value.workDisclosures !== undefined && !validWorkDisclosures(value.workDisclosures))
		)
			return null
		const screen = value.palScreen as WorkspacePresentation['palScreen']
		return {
			...value,
			// Older Pal views could open the ordinary conversation's technical pane.
			jobsOpen: palId ? false : value.jobsOpen,
			workDisclosures: palId ? undefined : value.workDisclosures,
			palScreen:
				typeof palId === 'string' &&
				palId.length > 0 &&
				screen &&
				screen.palId === palId &&
				['chat', 'computer'].includes(screen.activeTab)
					? screen
					: undefined,
		} as unknown as WorkspacePresentation
	} catch {
		return null
	}
}

export function writeWorkspacePresentation(
	storage: Pick<Storage, 'setItem'>,
	id: string,
	value: WorkspacePresentation,
): void {
	if (value.workDisclosures !== undefined && !validWorkDisclosures(value.workDisclosures))
		throw new TypeError('Invalid work disclosure choices')
	const serialized = JSON.stringify(value)
	if (serialized.length > 4096)
		throw new RangeError('Workspace presentation exceeds its read limit')
	storage.setItem(key(id), serialized)
}
