/** Isolated UI fixture; actual journal history and ACP tool mapping from the prior proof. */
export function installFixture({ fixture, appearance }) {
	localStorage.setItem('namzu.appearance', appearance)
	localStorage.setItem('namzu.sidebar-collapsed', 'true')
	let api
	let revision = 200
	const baseTime = Date.parse(fixture.journalClock.user)
	let controlledNow = baseTime + 60_000
	Date.now = () => controlledNow
	const listeners = new Set()
	const calls = { histories: [], external: [] }
	// This task-owned sessionStorage seam survives a document reload. Release is
	// explicit; no wall-clock delay or provider/native operation drives the proof.
	const deferredSession = sessionStorage.getItem('namzu.motion-proof.defer-history')
	sessionStorage.removeItem('namzu.motion-proof.defer-history')
	const makeHistoryGate = sessionId => {
		let release, requested
		return { sessionId, requested:false, released:false, completed:false,
			promise:new Promise(resolve => {release=resolve}),
			requestedPromise:new Promise(resolve => {requested=resolve}),
			release:()=>release(), notifyRequested:()=>requested() }
	}
	let historyGate = deferredSession ? makeHistoryGate(deferredSession) : null
	const workspace = { windowId: 'timing-window', sequence: 0, homeGroupId: 'timing-group', layout: { version: 1, revision: 0, windows: [{ id: 'timing-window', focusedGroupId: 'timing-group', root: { kind: 'group', id: 'timing-group', tabs: ['sample-thread-1', 'sample-thread-2', 'sample-thread-3'], activeTabId: 'sample-thread-1' } }] } }
	Object.defineProperty(window, 'namzu', { configurable: true, get: () => api, set(value) {
		api = value
		const base = { ...value }
		api.workspace = async () => structuredClone(workspace)
		api.workspaceAction = async action => {
			const group = workspace.layout.windows[0].root
			if (action.kind === 'open' || action.kind === 'activate') {
				if (!group.tabs.includes(action.tabId)) group.tabs.push(action.tabId)
				group.activeTabId = action.tabId
			} else if (action.kind === 'close') {
				group.tabs = group.tabs.filter(id => id !== action.tabId)
				if (group.activeTabId === action.tabId) group.activeTabId = group.tabs.at(-1) ?? ''
			}
			workspace.sequence++; workspace.layout.revision++
			return structuredClone(workspace)
		}
		api.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
		for (const name of ['draft', 'saveDraft', 'attachments', 'draftSettings', 'saveDraftSettings'])
			api[name] = (owner, ...args) => base[name](owner.replace(/:workspace:.*$/, ''), ...args)
		api.openConversation = async (projectId, sessionId) => {
			await base.openConversation(projectId, sessionId)
			calls.histories.push(sessionId)
			if (historyGate?.sessionId === sessionId && !historyGate.released) {
				historyGate.requested = true
				historyGate.notifyRequested()
				await historyGate.promise
			}
			const history = fixture.persistenceHistories?.[sessionId] ?? (sessionId === 'sample-thread-1' ? fixture.coldHistory : sessionId === 'sample-thread-2' ? fixture.legacyHistory : { messages: [], partial: false })
			const { restoreHistoryWork } = await import('/src/shared/history-work.ts')
			const { emptyThread } = await import('/src/shared/projection.ts')
			if (historyGate?.sessionId === sessionId) historyGate.completed = true
			return { ...structuredClone(history), thread: restoreHistoryWork(emptyThread(), structuredClone(history.messages), structuredClone(history.work)) }
		}
		api.openExternal = async url => { calls.external.push(url) }
		api.backgroundWorkStatuses = async () => ({})
		for (const name of ['send', 'startPalComputer', 'stopPalComputer', 'cancel'])
			api[name] = async () => { throw new Error('Native/provider action forbidden in transcript proof.') }
		window.__timingProof = {
			baseTime,
			setNow(at) { controlledNow = at; Date.now = () => controlledNow },
			calls: () => structuredClone(calls),
			deferHistoryOnReload(sessionId) { sessionStorage.setItem('namzu.motion-proof.defer-history', sessionId) },
			deferHistory(sessionId) {
				if (historyGate && !historyGate.released) throw new Error('An existing fixture history gate is still held.')
				historyGate = makeHistoryGate(sessionId)
			},
			waitForHistoryRequest() { if (!historyGate) throw new Error('No history gate was prepared.'); return historyGate.requestedPromise },
			deferredHistory: () => historyGate && ({ sessionId: historyGate.sessionId, requested: historyGate.requested, released: historyGate.released, completed:historyGate.completed }),
			releaseHistory() { if (historyGate && !historyGate.released) { historyGate.released = true; historyGate.release() } },
			emit(events) {
				for (const event of events) for (const listener of listeners)
					listener({ ...event, sessionId: 'sample-thread-3', projectId: 'sample-app', revision: ++revision })
			},
		}
	} })
}

/** Long synthetic histories exercise actual reader restoration without a model. */
export function persistenceFixture(source) {
	const fixture = structuredClone(source)
	const startedAt = Date.parse(source.journalClock.user)
	const makeHistory = owner => {
		const messages = [], work = { v: 1, partial: false, messages: [], turns: [], tools: [] }
		for (let turn = 0; turn < 4; turn++) {
			const turnId = `persistence-turn-${turn}`
			const order = turn * 100
			const firstUserId = `persistence-user-${turn}-0`
			work.turns.push({ turnId, userMessageId: firstUserId, order, status: 'completed', reason: 'end_turn', durationMs: 4321, startedAt: startedAt + turn * 60_000, endedAt: startedAt + turn * 60_000 + 4321 })
			// Two user/work/answer segments share one actual ordered turn; their
			// persisted disclosure keys must remain distinct from one another.
			for (let segment = 0; segment < 2; segment++) {
				const segmentOrder = order + segment * 20
				const id = role => `persistence-${role}-${turn}-${segment}`
				const append = (role, text, messageId, phase, at, relativeOrder) => {
					const index = messages.length
					messages.push({ role, text, messageId, phase, status: 'completed', time: { at, source: 'journal' } })
					work.messages.push({ index, messageId, turnId, order: segmentOrder + relativeOrder })
				}
				const at = startedAt + turn * 60_000 + segment * 2000
				append('user', `${owner} reader checkpoint ${turn + 1}.${segment + 1}: keep this saved work available.`, id('user'), undefined, at, 1)
				append('assistant', `${owner}: checking the recorded source for checkpoint ${turn + 1}.${segment + 1}.`, id('commentary'), 'commentary', at + 100, 2)
				work.tools.push({ ...structuredClone(source.coldHistory.work.tools[0]), turnId, toolUseId: `provider-hosted-web-search:0:persistence-search-${turn}-${segment}`, order: segmentOrder + 3, startedAt: at + 200, endedAt: at + 400 })
				const body = Array.from({ length: 12 }, (_, paragraph) => `${owner} checkpoint ${turn + 1}.${segment + 1}, paragraph ${paragraph + 1}. This public synthetic paragraph makes the saved history long enough to read away from its end. The reader should return to this same message and position.`).join('\n\n')
				append('assistant', body, id('answer'), 'final_answer', at + 800, 4)
			}
		}
		return { messages, partial: false, work }
	}
	fixture.persistenceHistories = { 'sample-thread-1': makeHistory('Owner A'), 'sample-thread-2': makeHistory('Owner B') }
	return fixture
}
