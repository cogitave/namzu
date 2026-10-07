import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react'
import { FileIcon } from './file-icons.js'
import { type ResolvedRefs, pathCandidates } from './project-refs.js'

/** What a reply's file links need: one batched lookup, and a way to show a file in the panel. */
export interface ProjectFiles {
	resolve(refs: readonly string[]): Promise<ResolvedRefs>
	open(path: string, line?: number): void
}

/** Absent in a chat without a project and in a Pal conversation, so nothing there becomes a link. */
export const ProjectFilesContext = createContext<ProjectFiles | null>(null)

const none: ResolvedRefs = new Map()
export const ResolvedRefsContext = createContext<ResolvedRefs>(none)

/**
 * The file references of one reply, looked up once it has settled. Streaming text never
 * triggers a lookup, and an unchanged reply reuses the host's earlier answer.
 */
export function useResolvedRefs(text: string, settled: boolean): ResolvedRefs {
	const files = useContext(ProjectFilesContext)
	const candidates = useMemo(
		() => (files && settled ? pathCandidates(text) : []),
		[files, settled, text],
	)
	const [found, setFound] = useState<{ refs: readonly string[]; value: ResolvedRefs }>({
		refs: [],
		value: none,
	})
	useEffect(() => {
		if (!files || candidates.length === 0) return
		let current = true
		void files.resolve(candidates).then((value) => {
			if (current) setFound({ refs: candidates, value })
		})
		return () => {
			current = false
		}
	}, [files, candidates])
	return found.refs === candidates ? found.value : none
}

/** True below a resolved file link, so a nested one stays text instead of nesting buttons. */
const InsideFileLinkContext = createContext(false)

export function ProjectFileLink({
	hit,
	children,
}: { hit: { path: string; line?: number }; children?: ReactNode }) {
	const files = useContext(ProjectFilesContext)
	const inside = useContext(InsideFileLinkContext)
	if (inside) return <>{children}</>
	return (
		<button
			type="button"
			className="message-file-link"
			title={hit.line ? `${hit.path}:${hit.line}` : hit.path}
			onClick={() => files?.open(hit.path, hit.line)}
		>
			<FileIcon aria-hidden="true" />
			<span>
				<InsideFileLinkContext.Provider value={true}>{children}</InsideFileLinkContext.Provider>
			</span>
		</button>
	)
}
