import type {
	RecordingAvailability,
	RecordingPlatform,
	RecordingUnavailable,
} from '../../shared/recording-protocol.js'
import { RECORDING_WORDS } from '../../shared/recording-protocol.js'

/**
 * Whether this computer can record, and why not. The first release records on a native Windows
 * desktop only. Where the answer is no the "Record your screen" item is absent; only a remote session
 * and security software get a sentence, because they are the two a person can understand and act on.
 */
export interface AvailabilityInputs {
	platform: NodeJS.Platform
	/** The environment, for the remote-session signal. */
	env: Readonly<Record<string, string | undefined>>
	/** Running inside WSL (a Linux build under Windows): never offered. */
	wsl?: boolean
	/** The native helper's capabilities, or undefined when there is no helper to ask. */
	helper: { present: boolean; caps?: readonly string[] }
	/** Settings, Privacy: the switch. */
	enabled: boolean
}

export function platformOf(platform: NodeJS.Platform): RecordingPlatform {
	return platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : 'other'
}

/**
 * A Windows remote desktop session. Windows names the session of a remote desktop `RDP-Tcp#<n>` in
 * `SESSIONNAME` (a local one says `Console`), and sets `CLIENTNAME` for the connecting computer. The
 * helper does not report `SM_REMOTESESSION` yet, so this is the signal; it is a best effort that a
 * real machine has to confirm, and a session with neither variable counts as local.
 */
export function isRemoteSession(env: Readonly<Record<string, string | undefined>>): boolean {
	const name = env.SESSIONNAME?.trim()
	if (name && /^(RDP|ICA)-/i.test(name)) return true
	// A remote desktop client names itself in `CLIENTNAME`; a console session never carries one.
	const client = env.CLIENTNAME?.trim()
	if (client && (!name || !/^console$/i.test(name))) return true
	return false
}

export function recordingAvailability(input: AvailabilityInputs): RecordingAvailability {
	const no = (reason: RecordingUnavailable, message?: string): RecordingAvailability => ({
		available: false,
		reason,
		...(message ? { message } : {}),
	})
	if (platformOf(input.platform) !== 'win32' || input.wsl) return no('platform')
	if (isRemoteSession(input.env)) return no('remote-session', RECORDING_WORDS.remote)
	if (!input.helper.present) return no('helper-missing')
	if (input.helper.caps && !input.helper.caps.includes('watch')) return no('helper-without-watch')
	if (!input.enabled) return no('switched-off')
	return { available: true }
}
