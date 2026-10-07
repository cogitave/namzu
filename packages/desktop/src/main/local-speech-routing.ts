import {
	LOCAL_SPEECH_PREVIEW_TEXT,
	type LocalSpeechEvent,
	type LocalSpeechSpeakInput,
	localSpeechRequestId,
	localSpeechText,
} from '../shared/local-speech-protocol.js'
import type { LocalSpeechService } from './local-speech.js'

type SpeechEngine = Pick<LocalSpeechService, 'state' | 'speak' | 'cancel' | 'acknowledge'>
interface RequestOwner {
	windowId: string
	sessionId?: string
}
export interface LocalSpeechRoutingOptions {
	/** Main's authenticated window lease; checked again on every audio frame. */
	assertOwner(windowId: string, sessionId?: string): void
	deliver(windowId: string, event: LocalSpeechEvent): void
}

/** Audio and ACKs belong to their requester, including cleanup after a tab transfer. */
export class LocalSpeechRouting {
	private readonly requests = new Map<string, RequestOwner>()
	constructor(
		private readonly engine: SpeechEngine,
		private readonly options: LocalSpeechRoutingOptions,
	) {}

	async speak(windowId: string, value: unknown): Promise<{ requestId: string }> {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid local speech request.')
		const input = value as LocalSpeechSpeakInput
		const requestId = localSpeechRequestId(input.requestId)
		if (input.language !== 'tr') throw new Error('EMA Lightning supports Turkish only.')
		if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !input.sessionId))
			throw new Error('Invalid speech conversation.')
		if (this.requests.has(requestId)) throw new Error('This speech request is already in use.')
		this.options.assertOwner(windowId, input.sessionId)
		const text =
			input.sessionId === undefined ? LOCAL_SPEECH_PREVIEW_TEXT : localSpeechText(input.text)
		const state = await this.engine.state()
		this.options.assertOwner(windowId, input.sessionId)
		if (input.sessionId !== undefined && !state.settings.enabled)
			throw new Error('Enable voice before reading a reply aloud.')
		if (this.requests.has(requestId)) throw new Error('This speech request is already in use.')
		const owner = { windowId, sessionId: input.sessionId }
		this.requests.set(requestId, owner)
		try {
			const accepted = await this.engine.speak({
				requestId,
				text,
				...(input.sessionId === undefined ? { preview: true } : {}),
			})
			this.options.assertOwner(windowId, input.sessionId)
			return accepted
		} catch (error) {
			if (this.requests.get(requestId) === owner) {
				this.engine.cancel(requestId)
				this.requests.delete(requestId)
			}
			throw error
		}
	}
	cancel(windowId: string, value: unknown): void {
		const requestId = localSpeechRequestId(value)
		const owner = this.requests.get(requestId)
		if (!owner) return
		if (owner.windowId !== windowId) throw new Error('This voice belongs to another window.')
		this.engine.cancel(requestId)
		this.requests.delete(requestId)
	}
	acknowledge(windowId: string, value: unknown, sequence: unknown): void {
		const requestId = localSpeechRequestId(value)
		const owner = this.requests.get(requestId)
		if (!owner) return
		if (owner.windowId !== windowId) throw new Error('This voice belongs to another window.')
		this.options.assertOwner(windowId, owner.sessionId)
		if (!Number.isSafeInteger(sequence) || (sequence as number) < 0)
			throw new Error('Invalid voice frame acknowledgement.')
		this.engine.acknowledge(requestId, sequence as number)
	}
	event(event: LocalSpeechEvent): void {
		if (event.type === 'state') return
		const owner = this.requests.get(event.requestId)
		if (!owner) return
		if (event.type === 'audio') {
			try {
				this.options.assertOwner(owner.windowId, owner.sessionId)
			} catch {
				this.engine.cancel(event.requestId)
				this.requests.delete(event.requestId)
				return
			}
		} else this.requests.delete(event.requestId)
		this.options.deliver(owner.windowId, event)
	}
	cancelWindow(windowId: string): void {
		for (const [requestId, owner] of [...this.requests])
			if (owner.windowId === windowId) this.cancel(windowId, requestId)
	}
}
