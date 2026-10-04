import type { DesktopApi } from '../shared/protocol.js'

export interface WorkspacePaneApiOptions {
	owns: (target: string) => boolean
	/** Freezing admission lets already admitted writes drain before ownership moves. */
	blocked: () => boolean
	beforeNewConversation?: () => Promise<void>
	/** The parent records the returned ID until its canonical layout event arrives. */
	created?: (id: string) => void
	allowGlobalMutations?: () => boolean
}

export interface WorkspacePaneApi {
	api: DesktopApi
	flush: () => Promise<void>
	invalidate: () => void
	activate: () => void
}

type Pending = { promise: Promise<unknown>; persistent: boolean }
type WriteOutcome = { sequence: number; error?: unknown; failed: boolean }

/** Pane admission complements main's window lease; neither renderer can write after a move. */
export function createWorkspacePaneApi(
	base: DesktopApi,
	options: WorkspacePaneApiOptions,
): WorkspacePaneApi {
	let generation = 0
	let invalidated = false
	let sequence = 0
	const pending = new Set<Pending>()
	const ownerWrites = new Map<string, Promise<unknown>>()
	const outcomes = new Map<string, WriteOutcome>()
	const {
		selectHarness,
		openChat,
		rebootPalComputer,
		takeOverPalComputer,
		returnPalComputerControl,
		palComputerInput,
	} = base
	const assertLifetime = (admittedGeneration = generation) => {
		if (invalidated || generation !== admittedGeneration)
			throw new Error('This conversation view has closed.')
	}
	const assertOwners = (owners: readonly string[]) => {
		for (const owner of owners) {
			if (
				typeof owner !== 'string' ||
				!owner ||
				(!owner.startsWith('project:') && !options.owns(owner))
			)
				throw new Error('This conversation moved to another pane. Open it there to continue.')
		}
	}
	const assertAdmission = (owners: readonly string[], global: boolean) => {
		assertLifetime()
		if (options.blocked()) throw new Error('This conversation is moving to another window.')
		if (global && options.allowGlobalMutations && !options.allowGlobalMutations())
			throw new Error('This conversation view is read-only.')
		assertOwners(owners)
	}
	const invoke = <T>(
		operation: (assertCurrent: () => void) => Promise<T>,
		owners: readonly string[] = [],
		settings: { global?: boolean; persistentKey?: string; serializeOwner?: string } = {},
	): Promise<T> => {
		try {
			assertAdmission(owners, settings.global ?? false)
		} catch (error) {
			return Promise.reject(error)
		}
		const admittedGeneration = generation
		const admittedSequence = ++sequence
		const run = () => {
			assertLifetime(admittedGeneration)
			// A freeze refuses new work, while already admitted work must finish before transfer ACK.
			assertOwners(owners)
			return operation(() => assertLifetime(admittedGeneration))
		}
		const previous = settings.serializeOwner ? ownerWrites.get(settings.serializeOwner) : undefined
		const result = (previous ?? Promise.resolve())
			.catch(() => {})
			.then(run)
			.then(
				(value) => {
					if (settings.persistentKey) {
						const last = outcomes.get(settings.persistentKey)
						if (!last || last.sequence <= admittedSequence)
							outcomes.set(settings.persistentKey, { sequence: admittedSequence, failed: false })
					}
					return value
				},
				(error) => {
					if (settings.persistentKey) {
						const last = outcomes.get(settings.persistentKey)
						if (!last || last.sequence <= admittedSequence)
							outcomes.set(settings.persistentKey, {
								sequence: admittedSequence,
								failed: true,
								error,
							})
					}
					throw error
				},
			)
		const tracked = { promise: result, persistent: !!settings.persistentKey }
		pending.add(tracked)
		if (settings.serializeOwner) ownerWrites.set(settings.serializeOwner, result)
		const settle = () => {
			pending.delete(tracked)
			if (settings.serializeOwner && ownerWrites.get(settings.serializeOwner) === result)
				ownerWrites.delete(settings.serializeOwner)
		}
		void result.then(settle, settle)
		return result
	}

	// Copy the frozen context bridge before replacing mutation methods. A Proxy over
	// its non-configurable methods would violate JavaScript's Proxy invariants.
	const api: DesktopApi = {
		...base,
		newConversation: (projectId) =>
			invoke(
				async (assertCurrent) => {
					await options.beforeNewConversation?.()
					assertCurrent()
					const conversation = await base.newConversation(projectId)
					assertCurrent()
					options.created?.(conversation.id)
					return conversation
				},
				[],
				{ global: true },
			),
		saveDraft: (owner, value) =>
			invoke(() => base.saveDraft(owner, value), [owner], {
				serializeOwner: owner,
				persistentKey: `draft:${owner}`,
			}),
		saveDraftSettings: (owner, value) => {
			const snapshot = structuredClone(value)
			return invoke(() => base.saveDraftSettings(owner, snapshot), [owner], {
				serializeOwner: owner,
				persistentKey: `settings:${owner}`,
			})
		},
		setPluginEnabled: (owner, name, enabled) =>
			invoke(() => base.setPluginEnabled(owner, name, enabled), [owner]),
		selectProvider: (owner, provider, model) =>
			invoke(() => base.selectProvider(owner, provider, model), [owner]),
		pickAttachments: (owner) => invoke(() => base.pickAttachments(owner), [owner]),
		addAttachments: (owner, files) => invoke(() => base.addAttachments(owner, files), [owner]),
		removeAttachment: (owner, id) => invoke(() => base.removeAttachment(owner, id), [owner]),
		moveAttachments: (from, to) => invoke(() => base.moveAttachments(from, to), [from, to]),
		send: (owner, prompt, settings) => invoke(() => base.send(owner, prompt, settings), [owner]),
		cancel: (owner) => invoke(() => base.cancel(owner), [owner]),
		takeQueued: (owner, itemId) => invoke(() => base.takeQueued(owner, itemId), [owner]),
		removeQueued: (owner, itemId) => invoke(() => base.removeQueued(owner, itemId), [owner]),
		approve: (owner, request, approved) =>
			invoke(() => base.approve(owner, request, approved), [owner]),
		stopJob: (owner, jobId) => invoke(() => base.stopJob(owner, jobId), [owner]),
		createPal: (input) => invoke(() => base.createPal(input), [], { global: true }),
		updatePal: (id, revision, changes) =>
			invoke(() => base.updatePal(id, revision, changes), [], { global: true }),
		startPalComputer: (id) => invoke(() => base.startPalComputer(id), [], { global: true }),
		stopPalComputer: (id) => invoke(() => base.stopPalComputer(id), [], { global: true }),
		openProject: () => invoke(() => base.openProject(), [], { global: true }),
		reconnectProject: (id) => invoke(() => base.reconnectProject(id), [], { global: true }),
		trustProject: (id) => invoke(() => base.trustProject(id), [], { global: true }),
		...(selectHarness
			? {
					selectHarness: (owner, harness) => invoke(() => selectHarness(owner, harness), [owner]),
				}
			: {}),
		...(openChat ? { openChat: () => invoke(() => openChat(), [], { global: true }) } : {}),
		...(rebootPalComputer
			? {
					rebootPalComputer: (id, computerGeneration) =>
						invoke(() => rebootPalComputer(id, computerGeneration), [], { global: true }),
				}
			: {}),
		...(takeOverPalComputer
			? {
					takeOverPalComputer: (id, computerGeneration) =>
						invoke(() => takeOverPalComputer(id, computerGeneration), [], { global: true }),
				}
			: {}),
		...(returnPalComputerControl
			? {
					returnPalComputerControl: (id, computerGeneration) =>
						invoke(() => returnPalComputerControl(id, computerGeneration), [], {
							global: true,
						}),
				}
			: {}),
		...(palComputerInput
			? {
					palComputerInput: (id, computerGeneration, input) =>
						invoke(() => palComputerInput(id, computerGeneration, input), [], {
							global: true,
						}),
				}
			: {}),
	}
	return {
		api,
		async flush() {
			let mutationFailure: unknown
			let mutationFailed = false
			while (pending.size) {
				const batch = [...pending]
				const results = await Promise.allSettled(batch.map((item) => item.promise))
				for (let index = 0; index < results.length; index++) {
					const result = results[index]
					if (result?.status === 'rejected' && !batch[index]?.persistent && !mutationFailed) {
						mutationFailed = true
						mutationFailure = result.reason
					}
				}
			}
			for (const outcome of outcomes.values()) if (outcome.failed) throw outcome.error
			if (mutationFailed) throw mutationFailure
		},
		invalidate() {
			invalidated = true
			generation++
		},
		activate() {
			invalidated = false
		},
	}
}
