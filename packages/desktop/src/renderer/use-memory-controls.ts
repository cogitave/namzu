import { useCallback, useEffect, useState } from 'react'
import type {
	SavedMemoriesView,
	SavedMemoryDetail,
	SavedMemoryOutcome,
	StandingInstructionsView,
} from '../shared/memory-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import { plainErrorText } from './plain-error.js'

type InstructionsBridge = Pick<DesktopApi, 'standingInstructions' | 'saveStandingInstructions'>
type MemoryBridge = Pick<
	DesktopApi,
	'savedMemories' | 'readSavedMemory' | 'updateSavedMemory' | 'deleteSavedMemory'
>

export interface InstructionsControls {
	/** The window and the engine can read and save them. */
	supported: boolean
	loading: boolean
	view?: StandingInstructionsView
	error?: string
	/** `changed`: the file moved on since it was read, nothing was written and the current text is shown. */
	save(text: string): Promise<'saved' | 'changed' | 'failed'>
}

/** The person's standing instructions, read when the page opens and again when the window regains focus. */
export function useStandingInstructions(api: InstructionsBridge | undefined): InstructionsControls {
	const read = api?.standingInstructions
	const write = api?.saveStandingInstructions
	const [state, setState] = useState<{
		loading: boolean
		view?: StandingInstructionsView | null
		error?: string
	}>({ loading: Boolean(read) })
	useEffect(() => {
		if (!read) return
		let live = true
		const load = () =>
			read().then(
				(view) => live && setState({ loading: false, view }),
				(failure) =>
					live &&
					setState((was) => ({
						...was,
						loading: false,
						error: plainErrorText(failure, 'read your instructions'),
					})),
			)
		void load()
		window.addEventListener('focus', load)
		return () => {
			live = false
			window.removeEventListener('focus', load)
		}
	}, [read])
	const revision = state.view?.revision
	const save = useCallback(
		async (text: string) => {
			if (!write) return 'failed' as const
			try {
				const view = await write(text, revision)
				setState({ loading: false, view })
				return view.changed ? ('changed' as const) : ('saved' as const)
			} catch (failure) {
				setState((was) => ({ ...was, error: plainErrorText(failure, 'save your instructions') }))
				return 'failed' as const
			}
		},
		[write, revision],
	)
	return {
		supported: Boolean(read && write) && state.view !== null,
		loading: state.loading,
		...(state.view ? { view: state.view } : {}),
		...(state.error ? { error: state.error } : {}),
		save,
	}
}

export interface SavedMemoryControls {
	supported: boolean
	loading: boolean
	view?: SavedMemoriesView
	error?: string
	reload(): void
	read(id: string): Promise<SavedMemoryDetail>
	update(change: {
		id: string
		revision: string
		text: string
		title?: string
	}): Promise<SavedMemoryOutcome>
	remove(change: { id: string; revision: string }): Promise<SavedMemoryOutcome>
}

/** The memories saved for one project; read when `enabled` turns on (the memory view opens). */
export function useSavedMemories(
	api: MemoryBridge | undefined,
	projectId: string | undefined,
	enabled: boolean,
): SavedMemoryControls {
	const list = api?.savedMemories
	const [state, setState] = useState<{
		loading: boolean
		view?: SavedMemoriesView | null
		error?: string
	}>({ loading: false })
	const [tick, setTick] = useState(0)
	useEffect(() => {
		if (!list || !projectId || !enabled) return
		let live = true
		setState((was) => ({ ...was, loading: true }))
		list(projectId).then(
			(view) => live && setState({ loading: false, view }),
			(failure) =>
				live &&
				setState({ loading: false, error: plainErrorText(failure, 'read the saved memory') }),
		)
		return () => {
			live = false
		}
	}, [list, projectId, enabled, tick])
	const reload = useCallback(() => setTick((n) => n + 1), [])
	const need = <T>(fn: T | undefined): T => {
		if (!fn || !projectId) throw new Error('This memory cannot be changed here.')
		return fn
	}
	return {
		supported: Boolean(list) && state.view !== null,
		loading: state.loading,
		...(state.view ? { view: state.view } : {}),
		...(state.error ? { error: state.error } : {}),
		reload,
		read: (id) => need(api?.readSavedMemory)(projectId as string, id),
		update: (change) => need(api?.updateSavedMemory)(projectId as string, change),
		remove: (change) => need(api?.deleteSavedMemory)(projectId as string, change),
	}
}
