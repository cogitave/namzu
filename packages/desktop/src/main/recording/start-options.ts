import type { ChooserMicrophone } from '../../shared/recording-protocol.js'

export interface RecordingStartOptions {
	provider: string
	microphones?: ChooserMicrophone[]
	microphone?: string
}

/** What the window may ask the recorder to start with, checked key by key. */
export function readRecordingStart(value: unknown): RecordingStartOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid recording request.')
	const raw = value as Record<string, unknown>
	if (typeof raw.provider !== 'string' || !raw.provider.trim() || raw.provider.length > 200)
		throw new Error('Invalid recording request.')
	const out: RecordingStartOptions = {
		// A person-visible sentence is built from this: control characters never reach it.
		provider: Array.from(raw.provider.trim(), (char) =>
			char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char,
		).join(''),
	}
	if (raw.microphones !== undefined) {
		if (!Array.isArray(raw.microphones) || raw.microphones.length > 20)
			throw new Error('Invalid recording request.')
		out.microphones = raw.microphones.map((item) => {
			const entry = item as Record<string, unknown> | null
			if (
				!entry ||
				typeof entry.id !== 'string' ||
				entry.id.length > 400 ||
				typeof entry.label !== 'string' ||
				entry.label.length > 200
			)
				throw new Error('Invalid recording request.')
			return { id: entry.id, label: entry.label || 'Microphone' }
		})
	}
	if (raw.microphone !== undefined) {
		if (typeof raw.microphone !== 'string' || raw.microphone.length > 400)
			throw new Error('Invalid recording request.')
		out.microphone = raw.microphone
	}
	return out
}
