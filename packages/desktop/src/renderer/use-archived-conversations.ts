import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationView, DesktopApi } from '../shared/protocol.js'
import {
	type ArchiveLoad,
	type ArchiveView,
	combineArchived,
	loadArchived,
	mergeArchived,
	withArchived,
	withoutArchived,
} from './sidebar-archive.js'

/**
 * Every archived conversation of the given projects, for the sidebar's archived view. Pass the
 * projects that can answer: a project that has not connected rejects its read. Each project is
 * read once, as soon as it is among them, so the section knows whether there is anything to show,
 * and every project is read again each time the view is switched on; rows already on screen stay
 * while that read runs. `read` names the projects whose archive the list holds in full.
 */
export function useArchivedConversations(
	api: Pick<DesktopApi, 'archivedConversations'>,
	projects: readonly { id: string }[],
	view: ArchiveView,
) {
	const [load, setLoad] = useState<ArchiveLoad>({ status: 'idle' })
	const [read, setRead] = useState<ReadonlySet<string>>(() => new Set())
	const generation = useRef(0)
	const list = api.archivedConversations
	const key = projects.map((project) => project.id).join('\0')
	const projectsRef = useRef(projects)
	projectsRef.current = projects
	const requested = useRef(new Set<string>())
	const readProjects = useCallback(
		(targets: readonly { id: string }[], replace: boolean) => {
			if (!list || targets.length === 0) return
			const mine = replace ? ++generation.current : generation.current
			const asked = targets.map((project) => project.id)
			for (const id of asked) requested.current.add(id)
			if (replace) setLoad((value) => (value.status === 'ready' ? value : { status: 'loading' }))
			void Promise.all(
				targets.map((project) =>
					loadArchived(list, [project]).then((part) => [project.id, part] as const),
				),
			).then((parts) => {
				// A newer full read overtook this one and covers the same projects.
				if (replace && mine !== generation.current) return
				const next = combineArchived(parts.map(([, part]) => part))
				setLoad((value) => (replace ? next : mergeArchived(value, next)))
				const done = parts.filter(([, part]) => part.status === 'ready').map(([id]) => id)
				for (const [id, part] of parts) if (part.status !== 'ready') requested.current.delete(id)
				setRead((value) => new Set(replace ? done : [...value, ...done]))
			})
		},
		[list],
	)
	const refresh = useCallback(() => {
		requested.current.clear()
		readProjects(projectsRef.current, true)
	}, [readProjects])
	// A project that connects after the first read is read when it does; one added later has no
	// archive yet, and extra reads at that moment only slow the host's answers the person waits for.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the ids in `key` are the whole input.
	useEffect(() => {
		const fresh = projectsRef.current.filter((project) => !requested.current.has(project.id))
		readProjects(fresh, false)
	}, [readProjects, key])
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
	return { load, read, refresh, add, remove }
}
