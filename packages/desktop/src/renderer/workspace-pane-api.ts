import type { DesktopApi, DesktopSendOptions } from '../shared/protocol.js'

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
	const speechRequests = new Map<string, string | undefined>()
	const {
		selectHarness,
		openChat,
		rebootPalComputer,
		takeOverPalComputer,
		returnPalComputerControl,
		palComputerInput,
		updatePalPermission,
		createPalSubscription,
		disablePalSubscription,
		retryTurn,
		deletePal,
		removeConversation,
		renameConversation,
		setConversationPinned,
		forkConversation,
		conversationMarkdown,
		projectGit,
		sendCurrent,
		localSpeechConfigure,
		localSpeechInstall,
		localSpeechSpeak,
		localSpeechCancel,
		localSpeechAcknowledge,
		onLocalSpeechEvent,
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
		settings: {
			global?: boolean
			persistentKey?: string
			serializeOwner?: string
		} = {},
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
							outcomes.set(settings.persistentKey, {
								sequence: admittedSequence,
								failed: false,
							})
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
		...(localSpeechConfigure
			? {
					localSpeechConfigure: (settings) => {
						const snapshot = structuredClone(settings)
						return invoke(() => localSpeechConfigure(snapshot), [], {
							global: true,
							serializeOwner: 'local-speech',
							persistentKey: 'local-speech',
						})
					},
				}
			: {}),
		...(localSpeechInstall
			? {
					localSpeechInstall: () => {
						try {
							assertAdmission([], true)
						} catch (error) {
							return Promise.reject(error)
						}
						const admittedGeneration = generation
						// An application-owned download does not delay a conversation transfer or draft flush.
						return localSpeechInstall().then((state) => {
							assertLifetime(admittedGeneration)
							return state
						})
					},
				}
			: {}),
		...(localSpeechSpeak
			? {
					localSpeechSpeak: (input) => {
						const snapshot = structuredClone(input)
						const owners = snapshot.sessionId === undefined ? [] : [snapshot.sessionId]
						return invoke(
							async (assertCurrent) => {
								if (speechRequests.has(snapshot.requestId))
									throw new Error('This speech request is already in use.')
								speechRequests.set(snapshot.requestId, snapshot.sessionId)
								try {
									const result = await localSpeechSpeak(snapshot)
									assertCurrent()
									assertOwners(owners)
									return result
								} catch (error) {
									void localSpeechCancel?.(snapshot.requestId).catch(() => {})
									speechRequests.delete(snapshot.requestId)
									throw error
								}
							},
							owners,
							{ global: snapshot.sessionId === undefined },
						)
					},
				}
			: {}),
		...(localSpeechCancel
			? {
					localSpeechCancel: (requestId) => {
						if (!speechRequests.has(requestId)) return Promise.resolve()
						speechRequests.delete(requestId)
						// Cleanup remains allowed after this requester loses its conversation lease.
						return localSpeechCancel(requestId)
					},
				}
			: {}),
		...(localSpeechAcknowledge
			? {
					localSpeechAcknowledge: (requestId, sequence) => {
						if (!speechRequests.has(requestId)) return Promise.resolve()
						const owner = speechRequests.get(requestId)
						return invoke(() => localSpeechAcknowledge(requestId, sequence), owner ? [owner] : [])
					},
				}
			: {}),
		...(onLocalSpeechEvent
			? {
					onLocalSpeechEvent: (listener) =>
						onLocalSpeechEvent((event) => {
							if (event.type !== 'state' && !speechRequests.has(event.requestId)) return
							if (event.type === 'end' || event.type === 'error')
								speechRequests.delete(event.requestId)
							listener(event)
						}),
				}
			: {}),
		...(updatePalPermission
			? {
					updatePalPermission: (owner, palId, change) => {
						const snapshot = structuredClone(change)
						return invoke(() => updatePalPermission(owner, palId, snapshot), [owner])
					},
				}
			: {}),
		...(createPalSubscription
			? {
					createPalSubscription: (owner, palId, input) => {
						const snapshot = structuredClone(input)
						return invoke(() => createPalSubscription(owner, palId, snapshot), [owner])
					},
				}
			: {}),
		...(disablePalSubscription
			? {
					disablePalSubscription: (owner, palId, input) => {
						const snapshot = structuredClone(input)
						return invoke(() => disablePalSubscription(owner, palId, snapshot), [owner])
					},
				}
			: {}),
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
		...(sendCurrent
			? {
					sendCurrent: (owner: string, prompt: string, settings?: DesktopSendOptions) =>
						invoke(() => sendCurrent(owner, prompt, settings), [owner]),
				}
			: {}),
		cancel: (owner) => invoke(() => base.cancel(owner), [owner]),
		takeQueued: (owner, itemId) => invoke(() => base.takeQueued(owner, itemId), [owner]),
		removeQueued: (owner, itemId) => invoke(() => base.removeQueued(owner, itemId), [owner]),
		approve: (owner, request, approved) =>
			invoke(() => base.approve(owner, request, approved), [owner]),
		stopJob: (owner, jobId) => invoke(() => base.stopJob(owner, jobId), [owner]),
		createPal: (input) => invoke(() => base.createPal(input), [], { global: true }),
		updatePal: (id, revision, changes) =>
			invoke(() => base.updatePal(id, revision, changes), [], { global: true }),
		...(deletePal
			? {
					deletePal: (id, revision) =>
						invoke(() => deletePal(id, revision), [], {
							global: true,
							serializeOwner: `pal:${id}`,
						}),
				}
			: {}),
		...(removeConversation
			? {
					removeConversation: (id) =>
						invoke(() => removeConversation(id), [], {
							global: true,
							serializeOwner: id,
						}),
				}
			: {}),
		// Sidebar rows have no tab in this pane, so these admit no owner (like removeConversation);
		// main refuses a conversation whose tab another window holds.
		...(renameConversation
			? {
					renameConversation: (id, title) =>
						invoke(() => renameConversation(id, title), [], { global: true, serializeOwner: id }),
				}
			: {}),
		...(setConversationPinned
			? {
					setConversationPinned: (id, pinned) =>
						invoke(() => setConversationPinned(id, pinned), [], {
							global: true,
							serializeOwner: id,
						}),
				}
			: {}),
		...(forkConversation
			? {
					forkConversation: (id) =>
						invoke(() => forkConversation(id), [], { global: true, serializeOwner: id }),
				}
			: {}),
		...(conversationMarkdown
			? { conversationMarkdown: (id) => invoke(() => conversationMarkdown(id), []) }
			: {}),
		...(projectGit ? { projectGit: (id) => invoke(() => projectGit(id), []) } : {}),
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
		...(retryTurn
			? {
					retryTurn: (owner, turnId, checkpointId, settings) =>
						invoke(() => retryTurn(owner, turnId, checkpointId, settings), [owner]),
				}
			: {}),
		...(openChat ? { openChat: () => invoke(() => openChat(), [], { global: true }) } : {}),
		...(rebootPalComputer
			? {
					rebootPalComputer: (id, computerGeneration) =>
						invoke(() => rebootPalComputer(id, computerGeneration), [], {
							global: true,
						}),
				}
			: {}),
		...(takeOverPalComputer
			? {
					takeOverPalComputer: (id, computerGeneration) =>
						invoke(() => takeOverPalComputer(id, computerGeneration), [], {
							global: true,
						}),
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
			for (const requestId of speechRequests.keys())
				void localSpeechCancel?.(requestId).catch(() => {})
			speechRequests.clear()
		},
		activate() {
			invalidated = false
		},
	}
}
