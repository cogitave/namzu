import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type {
	EngineUpdateId,
	EngineUpdateResult,
	EngineUpdatesState,
} from '../shared/engine-update-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import { engineToastText } from './engine-updates-model.js'
import { notify } from './notify.js'

export interface EngineUpdatesControls {
	state: EngineUpdatesState
	check: () => void
	/** Runs the update in a visible terminal tab of the given pane. */
	update: (
		id: EngineUpdateId,
		target: { groupId: string; projectId?: string },
	) => Promise<EngineUpdateResult>
	/** Opens Settings ▸ Updates in the pane that was focused last. */
	openUpdates: () => void
	/** A pane that can show Settings says so while it is focused. */
	registerOpenUpdates: (open: () => void) => () => void
}

export const EngineUpdatesContext = createContext<EngineUpdatesControls | undefined>(undefined)

/** The engine update controls of this window, or undefined where the window has none. */
export function useEngineUpdates(): EngineUpdatesControls | undefined {
	return useContext(EngineUpdatesContext)
}

const EMPTY: EngineUpdatesState = { items: [], checking: false }

/** What the window does with main's pushes; the hook supplies React's side of it. */
export interface EngineUpdatesSink {
	set: (state: EngineUpdatesState) => void
	notify: typeof notify
	/** Opens Settings ▸ Updates; called when the person acts on an announcement. */
	openUpdates: () => void
}

/**
 * Reads main's state once, follows its pushes, turns the notices of an update the person started into
 * toasts, and announces each newly found version once (main hands every version to one window only).
 * Returns the function that stops all of it.
 */
export function connectEngineUpdates(
	api: Pick<
		DesktopApi,
		'engineUpdates' | 'onEngineUpdates' | 'onEngineUpdateNotice' | 'claimEngineUpdateAnnouncements'
	>,
	sink: EngineUpdatesSink,
): () => void {
	if (!api.engineUpdates || !api.onEngineUpdates) return () => undefined
	let live = true
	let claiming = false
	const claim = () => {
		if (!api.claimEngineUpdateAnnouncements || claiming) return
		claiming = true
		void api
			.claimEngineUpdateAnnouncements()
			.then((found) => {
				if (!live) return
				for (const announcement of found)
					sink.notify(engineToastText(announcement), {
						tone: 'neutral',
						action: { label: 'Update…', onClick: sink.openUpdates },
					})
			})
			.catch(() => undefined)
			.finally(() => {
				claiming = false
			})
	}
	const settle = (next: EngineUpdatesState) => {
		if (!live) return
		sink.set(next)
		if (next.items.some((item) => item.status === 'available')) claim()
	}
	const stop = api.onEngineUpdates(settle)
	const stopNotice = api.onEngineUpdateNotice?.((notice) =>
		sink.notify(notice.text, { tone: notice.tone }),
	)
	void api
		.engineUpdates()
		.then(settle)
		.catch(() => undefined)
	return () => {
		live = false
		stop()
		stopNotice?.()
	}
}

/**
 * Main's state of the three programs, read once and then pushed. Notices from an update the person
 * started become toasts, and each newly found version is announced once.
 */
export function useEngineUpdatesController(
	api: DesktopApi | undefined,
	report: (failure: unknown) => void,
): EngineUpdatesControls | undefined {
	const [state, setState] = useState<EngineUpdatesState>(EMPTY)
	const openers = useRef<(() => void)[]>([])
	const supported = Boolean(api?.engineUpdates && api.onEngineUpdates)
	const reportRef = useRef(report)
	reportRef.current = report
	useEffect(() => {
		if (!api) return
		return connectEngineUpdates(api, {
			set: setState,
			notify,
			openUpdates: () => openers.current.at(-1)?.(),
		})
	}, [api])
	const check = useCallback(() => {
		void api?.checkEngineUpdates?.().catch((failure) => reportRef.current(failure))
	}, [api])
	const update = useCallback<EngineUpdatesControls['update']>(
		async (id, target) => {
			if (!api?.updateEngine) return { ok: false, reason: 'Updates are not available here.' }
			try {
				return await api.updateEngine({
					engine: id,
					groupId: target.groupId,
					...(target.projectId ? { projectId: target.projectId } : {}),
				})
			} catch (failure) {
				return { ok: false, reason: failure instanceof Error ? failure.message : String(failure) }
			}
		},
		[api],
	)
	const registerOpenUpdates = useCallback((open: () => void) => {
		openers.current.push(open)
		return () => {
			openers.current = openers.current.filter((item) => item !== open)
		}
	}, [])
	const openUpdates = useCallback(() => openers.current.at(-1)?.(), [])
	return useMemo(
		() => (supported ? { state, check, update, openUpdates, registerOpenUpdates } : undefined),
		[supported, state, check, update, openUpdates, registerOpenUpdates],
	)
}
