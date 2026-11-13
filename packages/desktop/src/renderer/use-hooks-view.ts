import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopApi, HooksView } from '../shared/protocol.js'
import { plainErrorText } from './plain-error.js'

type Bridge = Pick<DesktopApi, 'hooksView'>

/** What was last read, and for which project: a list never shows under another project's name. */
export interface HooksRead {
	/** The project the read was for; `own` when no project was open. */
	key: string
	view?: HooksView
	/** The engine does not know the question. */
	unsupported?: true
	error?: string
	loading: boolean
}

export interface HooksControls {
	read?: HooksRead
	/** The window has a way to ask at all. */
	supported: boolean
	/** Reads again, for example after the switch changed. */
	reload: () => void
}

export const OWN_KEY = 'own'

export function readKey(projectId: string | undefined): string {
	return projectId ?? OWN_KEY
}

/**
 * Reads what runs by itself for one project, or for the person's own settings. Only the newest read
 * may answer. A read of another project starts empty; a read of the same one keeps what is shown
 * until the answer replaces it.
 */
export class HooksReader {
	private latest = 0
	private current: HooksRead | undefined
	constructor(
		private readonly ask: (projectId: string | undefined) => Promise<HooksView | null>,
		private readonly publish: (read: HooksRead) => void,
	) {}
	load(projectId: string | undefined): void {
		const key = readKey(projectId)
		const mine = ++this.latest
		const same = this.current?.key === key
		const keep = same && this.current?.view ? { view: this.current.view } : {}
		this.set({ key, loading: true, ...keep })
		this.ask(projectId).then(
			(next) => {
				if (this.latest !== mine) return
				this.set(
					next ? { key, loading: false, view: next } : { key, loading: false, unsupported: true },
				)
			},
			(failure) => {
				if (this.latest !== mine) return
				this.set({
					key,
					loading: false,
					error: plainErrorText(failure, 'read the hooks'),
					...keep,
				})
			},
		)
	}
	stop(): void {
		this.latest++
	}
	private set(next: HooksRead): void {
		this.current = next
		this.publish(next)
	}
}

/** The read that belongs to `key`, or nothing yet when the last one was for another project. */
export function hooksReadFor(read: HooksRead | undefined, projectId: string | undefined) {
	return read && read.key === readKey(projectId) ? read : undefined
}

/** The open project's hooks (or the person's own when none is open), read when the page opens and when the window regains focus. */
export function useHooksView(
	api: Bridge | undefined,
	projectId: string | undefined,
): HooksControls {
	const [stored, setStored] = useState<HooksRead>()
	const ask = api?.hooksView
	const supported = Boolean(ask)
	const reader = useMemo(
		() => (ask ? new HooksReader((id) => ask(id), setStored) : undefined),
		[ask],
	)
	useEffect(() => {
		if (!reader) return
		reader.load(projectId)
		const refresh = () => reader.load(projectId)
		window.addEventListener('focus', refresh)
		return () => {
			window.removeEventListener('focus', refresh)
			reader.stop()
		}
	}, [reader, projectId])
	const reload = useCallback(() => reader?.load(projectId), [reader, projectId])
	return { read: hooksReadFor(stored, projectId), supported, reload }
}
