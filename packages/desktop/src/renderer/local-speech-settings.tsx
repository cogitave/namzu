import { Cpu, Download, Volume2 } from 'lucide-react'
import { useId, useState } from 'react'
import { LOCAL_SPEECH_MAX_TEXT, type LocalSpeechState } from '../shared/local-speech-protocol.js'
import { ChevronDownIcon, SquareIcon } from './icons.js'
import { Button } from './ui/button.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'
import { Select, SelectItem, SelectPopup, SelectTrigger } from './ui/select.js'
import type { LocalSpeechControls } from './use-local-speech.js'
import './local-speech-settings.css'

export function formatSpeechBytes(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value) || value < 0)
		return 'Not measured'
	if (value < 1_024) return `${Math.round(value)} B`
	if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`
	if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MiB`
	return `${(value / 1_073_741_824).toFixed(1)} GiB`
}

function voiceStatus(state: LocalSpeechState): string {
	if (state.installation === 'installing') return 'Downloading'
	if (state.installation === 'failed') return 'Unavailable'
	if (state.installation === 'missing') return 'Not downloaded'
	if (state.worker === 'speaking') return 'Speaking'
	if (state.worker === 'loading') return 'Loading voice'
	if (state.worker === 'unloaded') return 'Loads when needed'
	return 'Ready'
}

/** Pure content is also used by real-renderer browser checks. No measurement is guessed. */
export function LocalSpeechSettingsContent({
	speech,
	embedded = false,
}: {
	speech: LocalSpeechControls
	/** Inside the Settings page, which supplies the section heading. */
	embedded?: boolean
}) {
	const languageLabelId = useId()
	const [confirmingRemoval, setConfirmingRemoval] = useState(false)
	const Heading = embedded ? 'h3' : 'h2'
	const { state } = speech
	const disabled = !speech.supported || speech.loading || speech.busy || !state
	const downloading = state?.installation === 'installing'
	const previewing = speech.playingMessageId === 'preview'
	const error = speech.error ?? state?.error
	const installed = state?.installation === 'ready'
	return (
		<div className="local-speech-settings">
			<header className="local-speech-heading">
				<Heading>Voice</Heading>
				<span className="local-speech-badge">On this device</span>
			</header>
			<p className="local-speech-help">
				Reads replies aloud in Turkish. The voice runs on this device, so nothing is sent away.
			</p>
			{!speech.supported ? (
				<p className="local-speech-notice">Local speech is unavailable in this runtime.</p>
			) : speech.loading ? (
				<output className="local-speech-notice">Loading voice settings…</output>
			) : null}
			{installed && (
				<>
					<label className="local-speech-toggle">
						<span>Enable voice</span>
						<input
							type="checkbox"
							role="switch"
							className="settings-switch"
							aria-checked={state?.settings.enabled ?? false}
							checked={state?.settings.enabled ?? false}
							disabled={disabled}
							onChange={(event) => void speech.configure({ enabled: event.target.checked })}
						/>
					</label>
					<div className="local-speech-field">
						<span id={languageLabelId}>Speech language</span>
						<Select
							value={state?.settings.language ?? 'tr'}
							disabled={disabled}
							onValueChange={(value) => {
								if (value === 'tr') void speech.configure({ language: value })
							}}
						>
							<SelectTrigger aria-labelledby={languageLabelId} size="compact">
								Türkçe
							</SelectTrigger>
							<SelectPopup>
								<SelectItem value="tr">Türkçe · Turkish</SelectItem>
							</SelectPopup>
						</Select>
					</div>
				</>
			)}
			{state && !installed && (
				<section className="local-speech-engine" aria-label="Download the voice">
					<div>
						<strong>Turkish voice</strong>
						<span>
							{downloading
								? 'Downloading…'
								: `${formatSpeechBytes(state.resources.modelDownloadBytes)} to download, once.`}
						</span>
					</div>
					<span className="local-speech-badge">{voiceStatus(state)}</span>
				</section>
			)}
			{state && installed && <LocalSpeechResourceCard state={state} />}
			{installed && (
				<>
					<p className="local-speech-help local-speech-location">
						Stored on this device. Its folder is listed under About, Data folders.
					</p>
					<label className="local-speech-toggle local-speech-memory">
						<span>
							Free memory when idle
							<small>After 5 minutes. The next playback reloads the voice.</small>
						</span>
						<input
							type="checkbox"
							role="switch"
							className="settings-switch"
							aria-checked={!!state && state.settings.idleUnloadSeconds !== 0}
							checked={!!state && state.settings.idleUnloadSeconds !== 0}
							disabled={disabled}
							onChange={(event) =>
								void speech.configure({ idleUnloadSeconds: event.target.checked ? 300 : 0 })
							}
						/>
					</label>
				</>
			)}
			{error && (
				<p className="local-speech-notice local-speech-error" role="alert">
					{error}
				</p>
			)}
			<div className="local-speech-actions">
				{!installed ? (
					<Button
						size="sm"
						variant="outline"
						disabled={disabled || downloading}
						onClick={() => void speech.install()}
					>
						<Download aria-hidden="true" />
						{downloading
							? 'Downloading…'
							: state?.installation === 'failed'
								? 'Retry download'
								: 'Download voice'}
					</Button>
				) : (
					<Button
						size="sm"
						variant="outline"
						disabled={disabled}
						onClick={() => void speech.preview()}
					>
						{previewing ? <SquareIcon /> : <Volume2 aria-hidden="true" />}
						{previewing ? 'Stop preview' : 'Preview voice'}
					</Button>
				)}
				{installed &&
					(confirmingRemoval ? (
						<>
							<Button
								size="sm"
								variant="destructive-outline"
								disabled={disabled || downloading}
								onClick={() => {
									setConfirmingRemoval(false)
									void speech.uninstall()
								}}
							>
								Remove the downloaded voice
							</Button>
							<Button size="sm" variant="ghost" onClick={() => setConfirmingRemoval(false)}>
								Keep it
							</Button>
						</>
					) : (
						<Button
							size="sm"
							variant="ghost"
							disabled={disabled || downloading}
							onClick={() => setConfirmingRemoval(true)}
						>
							Remove voice…
						</Button>
					))}
				{speech.playingMessageId && !previewing && (
					<Button size="sm" variant="ghost" onClick={speech.stop}>
						Stop playback
					</Button>
				)}
			</div>
		</div>
	)
}

/** Only what has been measured: an unmeasured figure is left out, never shown as a placeholder. */
export function LocalSpeechResourceCard({
	state,
	showDetails = false,
}: { state: LocalSpeechState; showDetails?: boolean }) {
	const resources = state.resources
	const bytes = (value: number | null) =>
		value === null || !Number.isFinite(value) || value < 0 ? undefined : formatSpeechBytes(value)
	const number = (value: number | null, suffix: string) =>
		value === null || !Number.isFinite(value) ? undefined : `${Math.round(value)}${suffix}`
	const rows = [
		['Voice download', bytes(resources.modelDownloadBytes)],
		['Space used', bytes(resources.diskBytes)],
		['Memory in use', bytes(resources.ramBytes)],
		['First sound', number(resources.firstAudioMs, ' ms')],
	] as const
	const more = [
		['Speech engine download', bytes(resources.runtimeDownloadBytes)],
		['Processor use', number(resources.cpuPercent, '%')],
	] as const
	const shown = rows.filter(([, value]) => value !== undefined)
	const extra = more.filter(([, value]) => value !== undefined)
	if (shown.length === 0 && extra.length === 0) return null
	return (
		<section className="local-speech-resources" aria-label="Voice resource use">
			<header>
				<Cpu aria-hidden="true" />
				<span>Resources</span>
			</header>
			<dl>
				{shown.map(([label, value]) => (
					<div key={label}>
						<dt>{label}</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>
			{extra.length > 0 && (
				<Collapsible defaultOpen={showDetails} className="local-speech-resource-details">
					<CollapsibleTrigger className="local-speech-details-trigger">
						More resources <ChevronDownIcon />
					</CollapsibleTrigger>
					<CollapsiblePanel>
						<dl>
							{extra.map(([label, value]) => (
								<div key={label}>
									<dt>{label}</dt>
									<dd>{value}</dd>
								</div>
							))}
						</dl>
					</CollapsiblePanel>
				</Collapsible>
			)}
		</section>
	)
}

export function LocalSpeechReadAloud({
	speech,
	messageId,
	text,
}: {
	speech: LocalSpeechControls
	messageId: string
	text: string
}) {
	if (!speech.supported || !speech.state?.settings.enabled) return null
	const playing = speech.playingMessageId === messageId
	const tooLong = text.length > LOCAL_SPEECH_MAX_TEXT
	return (
		<Button
			size="icon-xs"
			variant="ghost-muted"
			className="local-speech-read-aloud"
			aria-label={playing ? 'Stop reading aloud' : 'Read aloud'}
			aria-pressed={playing}
			title={
				tooLong
					? 'Read aloud supports replies up to 8,000 characters.'
					: playing
						? 'Stop reading aloud'
						: 'Read aloud · Türkçe'
			}
			disabled={
				!playing &&
				(speech.busy || speech.state.installation !== 'ready' || !text.trim() || tooLong)
			}
			onClick={() => {
				if (playing) speech.stop()
				else void speech.readAloud(messageId, text)
			}}
		>
			{playing ? <SquareIcon /> : <Volume2 aria-hidden="true" />}
		</Button>
	)
}
