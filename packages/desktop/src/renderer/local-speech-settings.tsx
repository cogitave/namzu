import { Cpu, Download, Volume2 } from 'lucide-react'
import { useId } from 'react'
import { LOCAL_SPEECH_MAX_TEXT, type LocalSpeechState } from '../shared/local-speech-protocol.js'
import { ComposerControl } from './composer-control.js'
import { ChevronDownIcon, SquareIcon } from './icons.js'
import { Button } from './ui/button.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
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
export function LocalSpeechSettingsContent({ speech }: { speech: LocalSpeechControls }) {
	const languageLabelId = useId()
	const { state } = speech
	const disabled = !speech.supported || speech.loading || speech.busy || !state
	const downloading = state?.installation === 'installing'
	const previewing = speech.playingMessageId === 'preview'
	const error = speech.error ?? state?.error
	return (
		<div className="local-speech-settings">
			<header className="local-speech-heading">
				<h2>Voice</h2>
				<span className="local-speech-badge">On this device</span>
			</header>
			<p className="local-speech-help">Turkish speech runs on this device.</p>
			{!speech.supported ? (
				<p className="local-speech-notice">Local speech is unavailable in this runtime.</p>
			) : speech.loading ? (
				<output className="local-speech-notice">Loading voice settings…</output>
			) : null}
			<label className="local-speech-toggle">
				<span>Enable voice</span>
				<input
					type="checkbox"
					checked={state?.settings.enabled ?? false}
					disabled={disabled || downloading}
					onChange={(event) => void speech.configure({ enabled: event.target.checked })}
				/>
			</label>
			<div className="local-speech-field">
				<span id={languageLabelId}>Speech language</span>
				<Select
					value={state?.settings.language ?? 'tr'}
					disabled={disabled || downloading}
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
			<section className="local-speech-engine" aria-label="Local speech engine">
				<div>
					<strong>EMA Lightning</strong>
					<span>Turkish · One voice</span>
				</div>
				<span className="local-speech-badge">{state ? voiceStatus(state) : 'Not measured'}</span>
			</section>
			{state && <LocalSpeechResourceCard state={state} />}
			<label className="local-speech-toggle local-speech-memory">
				<span>
					Free memory when idle
					<small>After 5 minutes. The next playback reloads the voice.</small>
				</span>
				<input
					type="checkbox"
					checked={!!state && state.settings.idleUnloadSeconds !== 0}
					disabled={disabled || downloading}
					onChange={(event) =>
						void speech.configure({ idleUnloadSeconds: event.target.checked ? 300 : 0 })
					}
				/>
			</label>
			{error && (
				<p className="local-speech-notice local-speech-error" role="alert">
					{error}
				</p>
			)}
			<div className="local-speech-actions">
				{state?.installation !== 'ready' ? (
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
				{speech.playingMessageId && !previewing && (
					<Button size="sm" variant="ghost" onClick={speech.stop}>
						Stop playback
					</Button>
				)}
			</div>
		</div>
	)
}

export function LocalSpeechResourceCard({
	state,
	showDetails = false,
}: { state: LocalSpeechState; showDetails?: boolean }) {
	const resources = state.resources
	const number = (value: number | null, suffix: string) =>
		value === null || !Number.isFinite(value) ? 'Not measured' : `${Math.round(value)}${suffix}`
	return (
		<section className="local-speech-resources" aria-label="Voice resource use">
			<header>
				<Cpu aria-hidden="true" />
				<span>CPU · This device</span>
			</header>
			<dl>
				<div>
					<dt>Model download</dt>
					<dd>{formatSpeechBytes(resources.modelDownloadBytes)}</dd>
				</div>
				<div>
					<dt>Total installed size</dt>
					<dd>{formatSpeechBytes(resources.diskBytes)}</dd>
				</div>
				<div>
					<dt>Voice memory · RAM</dt>
					<dd>{formatSpeechBytes(resources.ramBytes)}</dd>
				</div>
				<div>
					<dt>First audio</dt>
					<dd>{number(resources.firstAudioMs, ' ms')}</dd>
				</div>
			</dl>
			<Collapsible defaultOpen={showDetails} className="local-speech-resource-details">
				<CollapsibleTrigger className="local-speech-details-trigger">
					More resources <ChevronDownIcon />
				</CollapsibleTrigger>
				<CollapsiblePanel>
					<dl>
						<div>
							<dt>Voice engine download</dt>
							<dd>{formatSpeechBytes(resources.runtimeDownloadBytes)}</dd>
						</div>
						<div>
							<dt title="Usage of the voice worker, relative to one CPU core">CPU use</dt>
							<dd>{number(resources.cpuPercent, '%')}</dd>
						</div>
						<div>
							<dt>GPU memory · VRAM</dt>
							<dd>Not used</dd>
						</div>
					</dl>
				</CollapsiblePanel>
			</Collapsible>
			<p>Memory and CPU cover the voice worker.</p>
		</section>
	)
}

export function LocalSpeechSettings({ speech }: { speech: LocalSpeechControls }) {
	return (
		<Popover>
			<PopoverTrigger
				render={<ComposerControl size="xs" />}
				aria-label="Voice settings"
				title="Voice settings"
			>
				<Volume2 aria-hidden="true" />
				{speech.state?.settings.enabled && <span>Türkçe</span>}
			</PopoverTrigger>
			<PopoverPopup
				align="end"
				side="top"
				sideOffset={8}
				padding="none"
				className="local-speech-popup"
				positionerClassName="local-speech-positioner"
				aria-label="Voice settings"
			>
				<LocalSpeechSettingsContent speech={speech} />
			</PopoverPopup>
		</Popover>
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
