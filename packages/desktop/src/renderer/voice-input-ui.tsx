import { Mic } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { XIcon } from './icons.js'
import { Button } from './ui/button.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import type { LocalListeningSnapshot } from './use-local-listening.js'
import type { VoiceInputControls, VoiceMicPhase } from './use-voice-input.js'
import './voice-input.css'

/** Why the microphone button cannot be used right now, in a sentence that says what to do. */
export const MIC_NEEDS_DOWNLOAD = 'Voice input needs a one-time download. Open Settings to get it.'
export const MIC_NEEDS_CONVERSATION = 'Send a first message to use voice input.'

export interface MicPresentation {
	label: string
	/** When set the button is unavailable and this says why. */
	reason?: string
	/** Pressing the unavailable button opens the voice input settings. */
	opensSettings: boolean
	phase: VoiceMicPhase
	pressed: boolean
}

const PHASE_STATUS: Record<Exclude<VoiceMicPhase, 'off'>, string> = {
	starting: 'Starting the microphone…',
	listening: 'Listening. Say “dur” to stop a reply.',
	hearing: 'Hearing you…',
	transcribing: 'Writing down what you said…',
}

export function micPresentation(input: {
	voice: Pick<VoiceInputControls, 'phase'>
	engine: Pick<LocalListeningSnapshot, 'state' | 'loading'>
	hasConversation: boolean
}): MicPresentation {
	const { phase } = input.voice
	if (phase !== 'off')
		return {
			label: 'Turn off voice input',
			phase,
			pressed: true,
			opensSettings: false,
		}
	if (input.engine.loading && !input.engine.state)
		return {
			label: 'Voice input',
			reason: 'Checking voice input…',
			phase,
			pressed: false,
			opensSettings: false,
		}
	if (input.engine.state?.installation !== 'ready')
		return {
			label: 'Voice input',
			reason: MIC_NEEDS_DOWNLOAD,
			phase,
			pressed: false,
			opensSettings: true,
		}
	if (!input.hasConversation)
		return {
			label: 'Voice input',
			reason: MIC_NEEDS_CONVERSATION,
			phase,
			pressed: false,
			opensSettings: false,
		}
	return { label: 'Turn on voice input', phase, pressed: false, opensSettings: false }
}

/** A quiet icon in the composer: off, starting, listening, hearing speech, or writing it down. */
export function VoiceMicButton({
	voice,
	engine,
	hasConversation,
	onOpenSettings,
}: {
	voice: VoiceInputControls
	engine: Pick<LocalListeningSnapshot, 'state' | 'loading' | 'supported'>
	hasConversation: boolean
	onOpenSettings(): void
}) {
	if (!voice.supported || !engine.supported) return null
	const view = micPresentation({ voice, engine, hasConversation })
	const unavailable = view.reason !== undefined
	const tip = view.reason ?? (view.phase === 'off' ? view.label : PHASE_STATUS[view.phase])
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						type="button"
						size="icon-xs"
						variant="ghost-muted"
						className="voice-mic"
						data-phase={view.phase}
						aria-label={unavailable ? `${view.label}. ${view.reason}` : view.label}
						aria-pressed={view.pressed}
						aria-disabled={unavailable}
						onClick={() => {
							if (unavailable) {
								if (view.opensSettings) onOpenSettings()
								return
							}
							voice.toggle()
						}}
					/>
				}
			>
				<Mic aria-hidden="true" />
				{view.phase !== 'off' && <span className="voice-mic-dot" aria-hidden="true" />}
			</TooltipTrigger>
			<TooltipPopup>{tip}</TooltipPopup>
		</Tooltip>
	)
}

/** Consent, the always-visible listening line, and any plain message about what just happened. */
export function VoiceInputStatus({ voice }: { voice: VoiceInputControls }) {
	const accept = useRef<HTMLButtonElement>(null)
	useEffect(() => {
		if (voice.consentOpen) accept.current?.focus()
	}, [voice.consentOpen])
	if (!voice.supported) return null
	const listening = voice.phase !== 'off'
	if (!voice.consentOpen && !listening && !voice.notice) return null
	return (
		<div className="voice-input-status">
			{voice.consentOpen && (
				<section
					className="voice-consent"
					aria-labelledby="voice-consent-title"
					onKeyDown={(event) => {
						if (event.key === 'Escape') voice.declineConsent()
					}}
				>
					<h3 id="voice-consent-title">Turn on voice input?</h3>
					<ul>
						<li>Namzu listens only while the microphone is on.</li>
						<li>Your audio stays on this computer.</li>
						<li>What you say is sent as a message, the same as typing it.</li>
						<li>
							Voice can’t approve actions. Questions about permissions are answered on screen.
						</li>
					</ul>
					<div className="voice-consent-actions">
						<Button ref={accept} size="sm" onClick={() => void voice.acceptConsent()}>
							Turn on voice input
						</Button>
						<Button size="sm" variant="ghost" onClick={voice.declineConsent}>
							Not now
						</Button>
					</div>
				</section>
			)}
			{listening && voice.phase !== 'off' && (
				<output className="voice-listening">{PHASE_STATUS[voice.phase]}</output>
			)}
			{voice.notice && (
				<output className="voice-notice" data-kind={voice.notice.kind}>
					<span>
						{voice.notice.text}
						{voice.notice.heard && <q>{voice.notice.heard}</q>}
					</span>
					<Button
						type="button"
						size="icon-xs"
						variant="ghost-muted"
						aria-label="Dismiss"
						onClick={voice.dismissNotice}
					>
						<XIcon />
					</Button>
				</output>
			)}
		</div>
	)
}
