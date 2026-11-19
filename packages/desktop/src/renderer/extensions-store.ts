import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
	type ExtensionAuditLine,
	type ExtensionFailure,
	type ExtensionRow,
	readAudit,
	readExtensionList,
	readFailure,
	readStateEvent,
} from '../shared/extensions-view.js'
import type { DesktopApi } from '../shared/protocol.js'

/**
 * The renderer's one view of extensions: the rows, which extension's screen Settings shows, and which
 * page of an extension is open in the window. A tiny external store so the rail button, Settings and the
 * page all read the same state without passing props through the whole app. Everything that reaches it
 * has gone through the readers of `shared/extensions-view.ts`.
 */

/** A dialog Settings should open on an extension's screen, asked for from outside it (a page's strip). */
export type PanelKind = 'notice' | 'licence' | 'record' | 'collected'

export interface OpenPage {
	extensionId: string
	pageId: string
	/** The person came from that extension's screen in Settings and goes back to it. */
	fromSettings: boolean
}

interface Snapshot {
	supported: boolean | undefined
	rows: readonly ExtensionRow[]
	/** The extension whose own screen Settings shows; none means the list. */
	selected: string | undefined
	/** The page of an extension that fills the main pane, if one is open. */
	page: OpenPage | undefined
	/** Counts up when something outside Settings asks for Settings to open on Extensions. */
	settingsRequest: number
	/** Counts up when a page that was opened from Settings is left: Settings opens again where it was. */
	settingsReturn: number
	panelRequest: { id: string; kind: PanelKind } | undefined
	loadedOnce: boolean
	error: string | undefined
}

let snapshot: Snapshot = {
	supported: undefined,
	rows: [],
	selected: undefined,
	page: undefined,
	settingsRequest: 0,
	settingsReturn: 0,
	panelRequest: undefined,
	loadedOnce: false,
	error: undefined,
}
const listeners = new Set<() => void>()
const set = (next: Partial<Snapshot>) => {
	snapshot = { ...snapshot, ...next }
	for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
	listeners.add(l)
	return () => listeners.delete(l)
}

/** The rail's Extensions button: Settings opens on the list (or the screen it was last on). */
export const openExtensionsPage = (): void => set({ settingsRequest: snapshot.settingsRequest + 1 })
/** Settings' own list and back arrow. */
export const selectExtension = (id: string | undefined): void => set({ selected: id })
export const openExtensionPage = (
	extensionId: string,
	pageId: string,
	fromSettings = false,
): void => set({ page: { extensionId, pageId, fromSettings } })
/** Leaves the open page. A page opened from Settings returns there; any other returns to the window it covered. */
export const closeExtensionPage = (): void => {
	const was = snapshot.page
	if (!was) return
	set({
		page: undefined,
		...(was.fromSettings
			? { selected: was.extensionId, settingsReturn: snapshot.settingsReturn + 1 }
			: {}),
	})
}
/** From a page's strip: Settings opens on that extension's screen with one of its dialogs. */
export const openExtensionPanel = (id: string, kind: PanelKind): void =>
	set({
		page: undefined,
		selected: id,
		panelRequest: { id, kind },
		settingsReturn: snapshot.settingsReturn + 1,
	})
export const takePanelRequest = (): void => set({ panelRequest: undefined })

/** The current state without React, for tests. */
export const snapshotForTest = (): Snapshot => snapshot

export function useExtensionsSnapshot(): Snapshot {
	return useSyncExternalStore(
		subscribe,
		() => snapshot,
		() => snapshot,
	)
}

type Api = Pick<DesktopApi, 'extensionsCall' | 'extensionsAddFromFile' | 'onEvent'>
const locale = (): string | undefined =>
	typeof navigator === 'undefined' ? undefined : navigator.language

/** `{ rows }` or the refusal the engine answered; null when the engine does not offer extensions. */
export async function callExtensions(
	api: Api,
	method: string,
	params: Record<string, unknown> = {},
): Promise<unknown> {
	if (!api.extensionsCall) return null
	// A locale the caller names (the one the notice was shown in) is never overridden by the window's own:
	// the acknowledgement records the language the person read.
	return api.extensionsCall(method, { ...(locale() ? { locale: locale() } : {}), ...params })
}

export async function refreshExtensions(api: Api): Promise<void> {
	try {
		const answer = await callExtensions(api, 'namzu/extensions/list')
		if (answer === null) return set({ supported: false, loadedOnce: true })
		const rows = readExtensionList(answer)
		if (!rows)
			return set({
				supported: true,
				loadedOnce: true,
				error: 'Namzu answered the extensions list in a way this app cannot read.',
			})
		set({ supported: true, rows, loadedOnce: true, error: undefined })
	} catch (error) {
		set({
			loadedOnce: true,
			error: error instanceof Error ? error.message : 'Could not read the extensions.',
		})
	}
}

/** How long state events that arrive together wait before one list is read. */
export const STATE_EVENT_DEBOUNCE_MS = 400
/** A steady stream of events still refreshes this often. */
export const STATE_EVENT_MAX_WAIT_MS = 3000

/**
 * How often the list is re-read on a timer. While an extension's page is open the page is already live
 * and the engine says every change it makes itself (a runner in another process is seen on this beat), so it gets the slow beat, not a fast one: a fast poll there only
 * queues work in front of the page's own calls. The fast beat is for Settings' own extension screen.
 */
export function listPollInterval(o: {
	settingsScreenOpen: boolean
	pageOpen: boolean
	anyEnabled: boolean
}): number {
	if (!o.pageOpen && o.settingsScreenOpen) return 4000
	return o.anyEnabled ? 15000 : 60000
}

/** Runs `fn` once, `ms` after the last `call`, and at the latest `maxWaitMs` after the first of a burst. */
export function debounced(
	fn: () => void,
	ms: number,
	maxWaitMs = Number.POSITIVE_INFINITY,
): { call: () => void; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined
	let first = 0
	return {
		call() {
			const t = Date.now()
			if (timer === undefined) first = t
			else clearTimeout(timer)
			const wait = Math.max(0, Math.min(ms, first + maxWaitMs - t))
			timer = setTimeout(() => {
				timer = undefined
				fn()
			}, wait)
		},
		cancel() {
			if (timer !== undefined) clearTimeout(timer)
			timer = undefined
		},
	}
}

/**
 * Mount once at the root: reads the list, listens for the engine's state events, and re-reads on a
 * slow beat so a mark never goes stale (faster while the page is open). Nothing is polled when the
 * engine does not offer extensions.
 */
export function useExtensionsSync(api: Api | undefined): void {
	const apiRef = useRef(api)
	apiRef.current = api
	const snap = useExtensionsSnapshot()
	useEffect(() => {
		const a = apiRef.current
		if (!a) return
		void refreshExtensions(a)
		const refreshSoon = debounced(
			() => void refreshExtensions(a),
			STATE_EVENT_DEBOUNCE_MS,
			STATE_EVENT_MAX_WAIT_MS,
		)
		const off = a.onEvent?.((event) => {
			if (event.kind !== 'extensions-state') return
			if (readStateEvent(event)) refreshSoon.call()
		})
		return () => {
			off?.()
			refreshSoon.cancel()
		}
	}, [])
	useEffect(() => {
		const a = apiRef.current
		if (!a || snap.supported === false) return
		const every = listPollInterval({
			settingsScreenOpen: snap.selected !== undefined,
			pageOpen: snap.page !== undefined,
			anyEnabled: snap.rows.some((r) => r.enabled),
		})
		const timer = setInterval(() => void refreshExtensions(a), every)
		return () => clearInterval(timer)
	}, [snap.selected, snap.page, snap.supported, snap.rows])
}

export interface Outcome<T> {
	ok: boolean
	value?: T
	failure?: ExtensionFailure
}

/** One call whose answer is either a refusal the person can read or a value. */
export async function ask(
	api: Api,
	method: string,
	params: Record<string, unknown> = {},
): Promise<Outcome<unknown>> {
	const answer = await callExtensions(api, method, params)
	const failure = readFailure(answer)
	if (failure) return { ok: false, failure }
	return { ok: true, value: answer }
}

export function useAudit(api: Api, id: string | undefined): ExtensionAuditLine[] | undefined {
	const [lines, setLines] = useState<ExtensionAuditLine[]>()
	useEffect(() => {
		if (!id) return
		let live = true
		void ask(api, 'namzu/extensions/audit', { id, limit: 100 }).then((r) => {
			if (live && r.ok) setLines(readAudit(r.value))
		})
		return () => {
			live = false
		}
	}, [api, id])
	return lines
}
