import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttachmentView } from '../shared/protocol.js'

/** Draft ownership is captured before a chooser or file read yields. */
export function useAttachments(
	owner: string,
	connected: boolean,
	onError: (error: unknown) => void,
) {
	const report = useRef(onError)
	report.current = onError
	const [all, setAll] = useState<Record<string, AttachmentView[]>>({})
	const values = useRef<Record<string, AttachmentView[]>>({})
	const revisions = useRef<Record<string, number>>({})
	const reads = useRef<Record<string, number>>({})
	const pending = useRef(new Set<string>())
	const [busy, setBusy] = useState<Record<string, boolean>>({})
	const put = useCallback((target: string, files: AttachmentView[]) => {
		values.current[target] = files
		setAll((current) => ({ ...current, [target]: files }))
	}, [])
	const reload = useCallback(
		async (target: string) => {
			const revision = revisions.current[target] ?? 0
			const read = (reads.current[target] ?? 0) + 1
			reads.current[target] = read
			const files = await window.namzu.attachments(target)
			if (read === reads.current[target] && revision === (revisions.current[target] ?? 0))
				put(target, files)
		},
		[put],
	)
	useEffect(() => {
		if (!connected || !owner) return
		let active = true
		const revision = revisions.current[owner] ?? 0
		const read = (reads.current[owner] ?? 0) + 1
		reads.current[owner] = read
		void window.namzu
			.attachments(owner)
			.then((files) => {
				if (
					active &&
					read === reads.current[owner] &&
					revision === (revisions.current[owner] ?? 0)
				) {
					values.current[owner] = files
					setAll((current) => ({ ...current, [owner]: files }))
				}
			})
			.catch((error: unknown) => {
				if (active && read === reads.current[owner]) report.current(error)
			})
		return () => {
			active = false
		}
	}, [owner, connected])
	const change = async (target: string, operation: () => Promise<AttachmentView[]>) => {
		if (pending.current.has(target)) return
		pending.current.add(target)
		revisions.current[target] = (revisions.current[target] ?? 0) + 1
		setBusy((current) => ({ ...current, [target]: true }))
		try {
			const files = await operation()
			// A read can begin while the native chooser is open. Its older result must
			// not replace the mutation's admitted files when that chooser completes.
			revisions.current[target] = (revisions.current[target] ?? 0) + 1
			put(target, files)
		} finally {
			pending.current.delete(target)
			setBusy((current) => ({ ...current, [target]: false }))
		}
	}
	return {
		files: all[owner] ?? [],
		busy: busy[owner] ?? false,
		isBusy: (target: string) => pending.current.has(target),
		get: (target: string) => values.current[target] ?? [],
		reload,
		pick: () => change(owner, () => window.namzu.pickAttachments(owner)),
		add: (files: File[]) =>
			change(owner, async () => {
				if (
					files.length > 8 ||
					files.some((file) => file.size > 3 * 1024 * 1024) ||
					files.reduce((sum, file) => sum + file.size, 0) > 3 * 1024 * 1024
				)
					throw new Error('Attach up to 8 files with a combined size of 3 MB.')
				const uploads = await Promise.all(
					files.map(async (file) => ({
						name: file.name,
						bytes: new Uint8Array(await file.arrayBuffer()),
					})),
				)
				return window.namzu.addAttachments(owner, uploads)
			}),
		remove: (id: string) =>
			change(owner, async () => {
				await window.namzu.removeAttachment(owner, id)
				return window.namzu.attachments(owner)
			}),
		promote: async (from: string, to: string) => {
			revisions.current[from] = (revisions.current[from] ?? 0) + 1
			revisions.current[to] = (revisions.current[to] ?? 0) + 1
			const files = await window.namzu.moveAttachments(from, to)
			revisions.current[from] = (revisions.current[from] ?? 0) + 1
			revisions.current[to] = (revisions.current[to] ?? 0) + 1
			put(from, [])
			put(to, files)
		},
		consume: (target: string, ids: string[]) => {
			revisions.current[target] = (revisions.current[target] ?? 0) + 1
			put(
				target,
				(values.current[target] ?? []).filter((file) => !ids.includes(file.id)),
			)
		},
	}
}
