import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopApi } from '../shared/protocol.js'
import type { ChooserMicrophone, RecordingReviewView } from '../shared/recording-protocol.js'
import type { ReviewEdit } from './record-review.js'
import { VoiceCapture, browserEnvironment } from './voice-capture.js'

/** The microphone the person used last, for as long as this window lives. */
let lastMicrophone = ''
const remembered = (): string => lastMicrophone
const remember = (id: string): void => {
	lastMicrophone = id
}

/** The microphones the system lists; labels come once the person has used voice input. */
export async function listMicrophones(): Promise<ChooserMicrophone[]> {
	const base: ChooserMicrophone[] = [{ id: '', label: 'System default' }]
	try {
		const devices = await navigator.mediaDevices.enumerateDevices()
		const inputs = devices.filter((device) => device.kind === 'audioinput' && device.deviceId)
		return [
			...base,
			...inputs
				.filter((device) => device.deviceId !== 'default')
				.map((device, index) => ({
					id: device.deviceId,
					label: device.label || `Microphone ${index + 1}`,
				})),
		]
	} catch {
		return base
	}
}

export interface RecordingControls {
	/** Record your screen is offered here. */
	available: boolean
	/** A finished recording waiting above the message box. */
	review: RecordingReviewView | undefined
	start: (provider: string) => Promise<void>
	edit: (edit: ReviewEdit) => Promise<void>
	discard: () => Promise<void>
	send: (ownerId: string, note: string) => Promise<{ text: string }>
}

/**
 * The window's side of Record your screen: whether the item is offered, the recording that waits
 * for review, and the microphone while narration runs. The pictures and events stay in the main
 * process; this holds only what the review sheet shows. It asks again whenever main reports a saved
 * setting, so the item follows the Privacy switch.
 */
export function useRecording(
	api: DesktopApi,
	options: {
		onMessage: (text: string) => void
		/** A recording is ready: the window shows a conversation to put it in. */
		onReview: () => void
	},
): RecordingControls {
	const [available, setAvailable] = useState(false)
	const [review, setReview] = useState<RecordingReviewView>()
	const capture = useRef<VoiceCapture | undefined>(undefined)
	const latest = useRef(options)
	latest.current = options

	useEffect(() => {
		let live = true
		const ask = () =>
			api
				.recordingAvailability?.()
				.then((answer) => live && setAvailable(answer.available))
				.catch(() => live && setAvailable(false))
		void ask()
		api
			.recordingReview?.()
			.then((view) => live && view && setReview(view))
			.catch(() => undefined)
		// Main sends `settings` once a change is saved, so the answer read then is the settled one;
		// the switch in Privacy is how the item is turned off, and the menu follows it.
		const stop = api.onEvent((event) => {
			if (event.kind === 'settings') void ask()
		})
		return () => {
			live = false
			stop()
		}
	}, [api])

	useEffect(() => {
		const stop = () => {
			capture.current?.stop()
			capture.current = undefined
		}
		const off = api.onRecordingNotice?.((notice) => {
			if (notice.type === 'review') {
				setReview(notice.view)
				latest.current.onReview()
			} else if (notice.type === 'review-closed') setReview(undefined)
			else if (notice.type === 'message') latest.current.onMessage(notice.text)
			else if (notice.type === 'narration') {
				stop()
				if (!notice.on) return
				remember(notice.microphone)
				const next = new VoiceCapture(
					browserEnvironment(notice.microphone || undefined),
					(samples) => void api.recordingAudio?.(samples).catch(() => undefined),
					() => void api.recordingNarrationLost?.().catch(() => undefined),
				)
				capture.current = next
				next.start().catch(() => void api.recordingNarrationLost?.().catch(() => undefined))
			}
		})
		return () => {
			off?.()
			stop()
		}
	}, [api])

	const start = useCallback(
		async (provider: string) => {
			const microphones = await listMicrophones()
			const result = await api.recordingStart?.({
				provider,
				microphones,
				microphone: remembered(),
			})
			if (result && !result.started && result.reason !== 'cancelled' && result.message)
				latest.current.onMessage(result.message)
		},
		[api],
	)
	const edit = useCallback(
		async (change: ReviewEdit) => {
			const view = await api.recordingEdit?.(change)
			setReview(view)
		},
		[api],
	)
	const discard = useCallback(async () => {
		await api.recordingDiscard?.()
		setReview(undefined)
	}, [api])
	const send = useCallback(
		async (ownerId: string, note: string) => {
			const sent = await api.recordingSend?.(ownerId, note.trim() || undefined)
			if (!sent) throw new Error('Update Namzu to send a recording.')
			setReview(undefined)
			return { text: sent.text }
		},
		[api],
	)
	return { available, review, start, edit, discard, send }
}
