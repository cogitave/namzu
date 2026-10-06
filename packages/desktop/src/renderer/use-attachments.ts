import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentView, DesktopApi } from '../shared/protocol.js'

/** Draft ownership is captured before a chooser or file read yields. */
export function useAttachments(
	owner: string,
	connected: boolean,
	onError: (error: unknown) => void,
	api: DesktopApi = window.namzu,
) {
	const report = useRef(onError)
	useLayoutEffect(() => {
		report.current = onError
	}, [onError])
	// Candidate caches are scoped to the bridge. An abandoned render must not
	// retire a committed read or expose another bridge's admitted files.
	const scope = useMemo(
		() => ({
			api,
			values: {} as Record<string, AttachmentView[]>,
			revisions: {} as Record<string, number>,
			reads: new Map<string, { revision: number; promise: Promise<void> }>(),
			pending: new Set<string>(),
		}),
		[api],
	)
	const activeOwner = useRef<{ owner: string; scope: typeof scope } | null>(null)
	const [snapshot, setSnapshot] = useState<{
		scope: typeof scope | null
		files: Record<string, AttachmentView[]>
		busy: Record<string, boolean>
	}>({ scope: null, files: {}, busy: {} })
	useLayoutEffect(() => {
		const lifetime = { owner, scope }
		activeOwner.current = lifetime
		return () => {
			if (activeOwner.current !== lifetime) return
			activeOwner.current = null
			// Readiness can pause without ending this lifetime. Actual navigation
			// retires only the departed owner's read, not a next-owner setup read.
			scope.reads.delete(owner)
		}
	}, [owner, scope])
	const put = useCallback(
		(target: string, files: AttachmentView[]) => {
			if (activeOwner.current?.scope !== scope) return
			scope.values[target] = files
			setSnapshot((current) => ({
				scope,
				files: { ...(current.scope === scope ? current.files : scope.values), [target]: files },
				busy: current.scope === scope ? current.busy : {},
			}))
		},
		[scope],
	)
	const setBusy = (target: string, busy: boolean) => {
		if (activeOwner.current?.scope !== scope) return
		setSnapshot((current) => ({
			scope,
			files: current.scope === scope ? current.files : { ...scope.values },
			busy: { ...(current.scope === scope ? current.busy : {}), [target]: busy },
		}))
	}
	const reload = useCallback(
		(target: string): Promise<void> => {
			const revision = scope.revisions[target] ?? 0
			if (activeOwner.current?.scope !== scope)
				return Promise.reject(
					new Error('This conversation’s attachments changed while loading. Try again.'),
				)
			const current = scope.reads.get(target)
			if (current?.revision === revision) return current.promise
			const read: { revision: number; promise: Promise<void> } = {
				revision,
				promise: Promise.resolve()
					.then(() => scope.api.attachments(target))
					.then((files) => {
						if (
							activeOwner.current?.scope !== scope ||
							scope.reads.get(target) !== read ||
							revision !== (scope.revisions[target] ?? 0)
						)
							throw new Error('This conversation’s attachments changed while loading. Try again.')
						put(target, files)
					})
					.finally(() => {
						if (scope.reads.get(target) === read) scope.reads.delete(target)
					}),
			}
			scope.reads.set(target, read)
			return read.promise
		},
		[put, scope],
	)
	useEffect(() => {
		if (!connected || !owner) return
		const lifetime = activeOwner.current
		let active = true
		const revision = scope.revisions[owner] ?? 0
		// Progressive conversation opening starts its explicit reload before this
		// owner's effect. Share that read so awaiting it confirms admitted files.
		if (scope.values[owner] === undefined || scope.reads.has(owner))
			void reload(owner).catch((error: unknown) => {
				if (
					active &&
					activeOwner.current === lifetime &&
					lifetime?.owner === owner &&
					lifetime.scope === scope &&
					revision === (scope.revisions[owner] ?? 0)
				)
					report.current(error)
			})
		return () => {
			active = false
		}
	}, [owner, connected, reload, scope])
	const change = async (target: string, operation: () => Promise<AttachmentView[]>) => {
		if (activeOwner.current?.scope !== scope)
			throw new Error('This conversation’s attachments changed. Try again.')
		if (scope.pending.has(target)) return
		scope.pending.add(target)
		scope.revisions[target] = (scope.revisions[target] ?? 0) + 1
		setBusy(target, true)
		try {
			const files = await operation()
			// A read can begin while the native chooser is open. Its older result must
			// not replace the mutation's admitted files when that chooser completes.
			scope.revisions[target] = (scope.revisions[target] ?? 0) + 1
			put(target, files)
		} finally {
			scope.pending.delete(target)
			setBusy(target, false)
		}
	}
	return {
		files: snapshot.scope === scope ? (snapshot.files[owner] ?? []) : [],
		loaded: snapshot.scope === scope && snapshot.files[owner] !== undefined,
		busy: snapshot.scope === scope && (snapshot.busy[owner] ?? false),
		isBusy: (target: string) => scope.pending.has(target),
		get: (target: string) => scope.values[target] ?? [],
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
			scope.revisions[from] = (scope.revisions[from] ?? 0) + 1
			scope.revisions[to] = (scope.revisions[to] ?? 0) + 1
			const files = await api.moveAttachments(from, to)
			scope.revisions[from] = (scope.revisions[from] ?? 0) + 1
			scope.revisions[to] = (scope.revisions[to] ?? 0) + 1
			put(from, [])
			put(to, files)
		},
		consume: (target: string, ids: string[]) => {
			scope.revisions[target] = (scope.revisions[target] ?? 0) + 1
			put(
				target,
				(scope.values[target] ?? []).filter((file) => !ids.includes(file.id)),
			)
		},
	}
}
