import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationView, DesktopApi } from '../shared/protocol.js'
import {
	type ArchiveLoad,
	type ArchiveView,
	loadArchived,
	withArchived,
	withoutArchived,
} from './sidebar-archive.js'

/**
 * Every archived conversation of the given projects, for the sidebar's archived view. It is read
 * once after the first projects arrive, so the section knows whether there is anything to show, and
 * again each time the view is switched on; rows already on screen stay while that read runs.
 */
export function useArchivedConversations(
	api: Pick<DesktopApi, 'archivedConversations'>,
	projects: readonly { id: string }[],
	view: ArchiveView,
) {
	const [load, setLoad] = useState<ArchiveLoad>({ status: 'idle' })
	const generation = useRef(0)
	const list = api.archivedConversations
	const key = projects.map((project) => project.id).join('\0')
	const projectsRef = useRef(projects)
	projectsRef.current = projects
	const refresh = useCallback(() => {
		if (!list || projectsRef.current.length === 0) return
		const mine = ++generation.current
		setLoad((value) => (value.status === 'ready' ? value : { status: 'loading' }))
		void loadArchived(list, projectsRef.current).then((next) => {
			if (mine === generation.current) setLoad(next)
		})
	}, [list])
	// One read once the first projects are known; a project added later has no archive yet, and
	// extra reads at that moment only slow the host's answers the person is waiting for.
	const started = useRef(false)
	useEffect(() => {
		if (key === '' || started.current) return
		started.current = true
		refresh()
	}, [refresh, key])
	const shown = view === 'archived'
	// biome-ignore lint/correctness/useExhaustiveDependencies: a read runs only when the view turns on.
	useEffect(() => {
		if (shown) refresh()
	}, [shown])
	const add = useCallback((value: ConversationView) => {
		generation.current += 1
		setLoad((current) => withArchived(current, value))
	}, [])
	// A read still in flight predates this change and would bring the row back.
	const remove = useCallback((id: string) => {
		generation.current += 1
		setLoad((current) => withoutArchived(current, id))
	}, [])
	return { load, refresh, add, remove }
}
