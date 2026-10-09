/**
 * Starting a Pal for the messages waiting in its inbox, on the owner's click in the Desktop.
 *
 * The start never runs inside the sender's tool call: the Desktop asks this host, which answers
 * at once and runs the one finite dispatch in the background. The click is the consent. Nothing
 * here widens what the Pal may do; the dispatch runs the Pal's own conversation under its own
 * permission rules.
 */
import { randomUUID } from 'node:crypto'
import type { PalIngressDispatchOutcome } from '@namzu/sdk'
import type { CommandContext } from '../commands/types.js'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import { cliPalCommunicationStore } from './communication.js'
import { dispatchCliPalMessages } from './dispatch.js'
import { cliPalComputerStatus, existingCliPalRuntime } from './environment.js'
import { getCliPalStore } from './store.js'

/** What the Desktop shows for one Pal's waiting messages. */
export interface PalInboxStartView {
	readonly v: 1
	readonly palId: string
	/** Messages from the owner's conversations that no run has read yet. */
	readonly waiting: number
	/**
	 * `waiting`: messages are queued and nothing is running; `reading`: a run (started here or by
	 * an open conversation) is reading them; `failed`: the last start did not finish; `empty`:
	 * nothing is waiting.
	 */
	readonly state: 'empty' | 'waiting' | 'reading' | 'failed'
	/** Plain words for `failed`, ready to show. */
	readonly message?: string
}

export interface PalInboxStartDeps {
	readonly dispatch?: typeof dispatchCliPalMessages
	readonly computer?: (palId: string) => Promise<{ status: string; notice?: string }>
	readonly busy?: (palId: string) => Promise<boolean>
	readonly newId?: () => string
}

const CLICK_ID = /^[A-Za-z0-9_-]{8,80}$/u

function plainFailure(name: string, error: unknown): string {
	const text = error instanceof Error ? error.message : String(error)
	if (/busy in another conversation/iu.test(text))
		return `${name} is busy. It will read your message at its next step.`
	if (/model provider/iu.test(text))
		return `${name} has no model chosen yet. Choose one in ${name}’s settings, then start it again.`
	if (/refused|explicit go/iu.test(text))
		return `${name} could not be started: your go was not accepted. Try again.`
	return `${name} could not be started. Try again in a moment.`
}

export function createPalInboxStarter(
	context: CommandContext | (() => CommandContext),
	deps: PalInboxStartDeps = {},
) {
	const dispatch = deps.dispatch ?? dispatchCliPalMessages
	const computer = deps.computer ?? cliPalComputerStatus
	const busy =
		deps.busy ??
		(async (palId: string) =>
			(await existingCliPalRuntime().catch(() => null))?.busy(palId) ?? false)
	const jobs = new Map<string, { controller: AbortController; done: Promise<void> }>()
	const failures = new Map<string, string>()
	const starting = new Map<string, Promise<PalInboxStartView>>()

	async function waitingCount(palId: string): Promise<number> {
		const pal = getCliPalStore().get(palId)
		if (!pal) throw new Error('This Pal is unavailable.')
		const identity = await openSessions(pal.workspace)
		const address = { tenantId: identity.tenantId, palId }
		closeSessions(identity)
		const snapshot = await cliPalCommunicationStore().readIngress(address)
		return (snapshot?.messages ?? []).filter(
			(message) => 'kind' in message && message.kind === 'operator' && message.phase !== 'recorded',
		).length
	}

	async function status(palId: string): Promise<PalInboxStartView> {
		const waiting = await waitingCount(palId)
		const failure = failures.get(palId)
		const reading = jobs.has(palId) || (waiting > 0 && (await busy(palId)))
		const state = reading
			? 'reading'
			: failure && waiting > 0
				? 'failed'
				: waiting > 0
					? 'waiting'
					: 'empty'
		return {
			v: 1,
			palId,
			waiting,
			state,
			...(state === 'failed' && failure ? { message: failure } : {}),
		}
	}

	/**
	 * Start on a click. Idempotent: a second click while a run is live starts nothing. The Desktop
	 * validated the Pal and the click; this host re-checks the Pal because the registry is its own.
	 */
	function start(palId: string, clickId: string): Promise<PalInboxStartView> {
		// Admission happens across awaits, so a second click joins the first one's answer
		// instead of racing it to a second run.
		const joined = starting.get(palId)
		if (joined) return joined
		const admission = admit(palId, clickId).finally(() => {
			starting.delete(palId)
		})
		starting.set(palId, admission)
		return admission
	}

	async function admit(palId: string, clickId: string): Promise<PalInboxStartView> {
		if (!CLICK_ID.test(clickId)) throw new Error('A start needs the person’s own click.')
		const pal = getCliPalStore().get(palId)
		if (!pal) throw new Error('This Pal is unavailable.')
		if (pal.paused) throw new Error(`${pal.name} is paused. Resume it first.`)
		if (jobs.has(palId)) return status(palId)
		const waiting = await waitingCount(palId)
		if (waiting === 0 || (await busy(palId))) return status(palId)
		const computerState = await computer(palId)
		if (computerState.status === 'unavailable') {
			const message = `${pal.name}’s computer is not available on this machine yet. Install and start Docker or Podman, then start ${pal.name} again.`
			failures.set(palId, message)
			return status(palId)
		}
		failures.delete(palId)
		const controller = new AbortController()
		const evidence = `desktop-click:${clickId}:${(deps.newId ?? randomUUID)().slice(0, 8)}`
		const run = dispatch(
			typeof context === 'function' ? context() : context,
			palId,
			controller.signal,
			{ operatorWake: { evidence } },
		).then(
			(outcome: PalIngressDispatchOutcome) => {
				if (outcome.status === 'blocked') failures.set(palId, `${pal.name} could not be started.`)
			},
			(error: unknown) => {
				failures.set(palId, plainFailure(pal.name, error))
			},
		)
		const job = {
			controller,
			done: run.finally(() => {
				jobs.delete(palId)
			}),
		}
		jobs.set(palId, job)
		return status(palId)
	}

	return {
		status,
		start,
		/** Resolves when no start is running; tests await it, the host awaits it on close. */
		async idle(): Promise<void> {
			await Promise.all([...jobs.values()].map((job) => job.done))
		},
		close(): Promise<void> {
			for (const job of jobs.values()) job.controller.abort(new Error('Pal start cancelled.'))
			return this.idle()
		},
	}
}

export type CliPalInboxStarter = ReturnType<typeof createPalInboxStarter>
