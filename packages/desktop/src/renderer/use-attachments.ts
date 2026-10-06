import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttachmentView, DesktopApi } from '../shared/protocol.js'

/** Draft ownership is captured before a chooser or file read yields. */
export function useAttachments(
	owner: string,
	connected: boolean,
	onError: (error: unknown) => void,
	api: DesktopApi = window.namzu,
) {
	const report = useRef(onError)
	report.current = onError
	const bridge = useRef(api)
	bridge.current = api
	const [all, setAll] = useState<Record<string, AttachmentView[]>>({})
	const values = useRef<Record<string, AttachmentView[]>>({})
	const revisions = useRef<Record<string, number>>({})
	const reads = useRef(
		new Map<string, { revision: number; api: DesktopApi; promise: Promise<void> }>(),
	)
	const pending = useRef(new Set<string>())
	const [busy, setBusy] = useState<Record<string, boolean>>({})
	const put = useCallback((target: string, files: AttachmentView[]) => {
		values.current[target] = files
		setAll((current) => ({ ...current, [target]: files }))
	}, [])
	const reload = useCallback(
		(target: string): Promise<void> => {
			const revision = revisions.current[target] ?? 0
			const current = reads.current.get(target)
			if (current?.revision === revision && current.api === api) return current.promise
			const read: { revision: number; api: DesktopApi; promise: Promise<void> } = {
				revision,
				api,
				promise: Promise.resolve()
					.then(() => api.attachments(target))
					.then((files) => {
						if (
							bridge.current !== api ||
							reads.current.get(target) !== read ||
							revision !== (revisions.current[target] ?? 0)
						)
							throw new Error('This conversation’s attachments changed while loading. Try again.')
						put(target, files)
					})
					.finally(() => {
						if (reads.current.get(target) === read) reads.current.delete(target)
					}),
			}
			reads.current.set(target, read)
			return read.promise
		},
		[put, api],
	)
	useEffect(() => {
		if (!connected || !owner) return
		let active = true
		const revision = revisions.current[owner] ?? 0
		// Progressive conversation opening starts its explicit reload before this
		// owner's effect. Share that read so awaiting it confirms admitted files.
		if (values.current[owner] === undefined || reads.current.has(owner))
			void reload(owner).catch((error: unknown) => {
				if (active && revision === (revisions.current[owner] ?? 0)) report.current(error)
			})
		return () => {
			active = false
		}
	}, [owner, connected, reload])
	useEffect(
		() => () => {
			// Setup readiness may pause while the same owner changes its engine or
			// reloads history. Only leaving that owner or bridge retires its snapshot.
			if (reads.current.get(owner)?.api === api) reads.current.delete(owner)
		},
		[owner, api],
	)
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
		loaded: all[owner] !== undefined,
		busy: busy[owner] ?? false,
		isBusy: (target: string) => pending.current.has(target),
		get: (target: string) => values.current[target] ?? [],
		reload,
		pick: () => change(owner, () => api.pickAttachments(owner)),
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
				return api.addAttachments(owner, uploads)
			}),
		remove: (id: string) =>
			change(owner, async () => {
				await api.removeAttachment(owner, id)
				return api.attachments(owner)
			}),
		promote: async (from: string, to: string) => {
			revisions.current[from] = (revisions.current[from] ?? 0) + 1
			revisions.current[to] = (revisions.current[to] ?? 0) + 1
			const files = await api.moveAttachments(from, to)
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
