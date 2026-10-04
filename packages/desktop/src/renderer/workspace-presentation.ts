import type { ComputerChatLayout } from './computer-chat-motion.js'

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
			value.scrollTop < 0
		)
			return null
		const screen = value.palScreen as WorkspacePresentation['palScreen']
		return {
			...value,
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
	storage.setItem(key(id), JSON.stringify(value))
}
