import { Download } from 'lucide-react'
import { useState } from 'react'
import { formatSize } from '../shared/format-size.js'
import type { LocalListeningState } from '../shared/local-listening-protocol.js'
import { Button } from './ui/button.js'
import type { LocalListeningControls } from './use-local-listening.js'
import './local-speech-settings.css'

/** "About 1 GB" for a download that is a little under a gigabyte; exact figures stay out of sentences. */
export function approximateDownload(bytes: number): string {
	const gigabyte = 1024 ** 3
	if (!Number.isFinite(bytes) || bytes <= 0) return 'a large file'
	if (bytes < 0.9 * gigabyte) return `about ${formatSize(bytes)}`
	const gigabytes = Math.round((bytes / gigabyte) * 10) / 10
	return `about ${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)} GB`
}

/** What the download row says for the step it is on. */
export function listeningDownloadStatus(state: LocalListeningState): string {
	const progress = state.progress
	if (progress?.step === 'checking') return 'Checking the download…'
	if (progress?.step === 'downloading' && progress.downloadedBytes !== undefined) {
		const total = progress.totalBytes ? ` of ${formatSize(progress.totalBytes)}` : ''
		return `Downloading · ${formatSize(progress.downloadedBytes)}${total}`
	}
	return 'Getting ready…'
}

export function LocalListeningSettingsContent({
	listening,
	accepted,
	onAcceptedChange,
	embedded = false,
}: {
	listening: LocalListeningControls
	/** Whether Namzu may use the microphone; absent hides the switch. */
	accepted?: boolean
	onAcceptedChange?(value: boolean): void
	embedded?: boolean
}) {
	const [confirmingRemoval, setConfirmingRemoval] = useState(false)
	const Heading = embedded ? 'h3' : 'h2'
	const { state } = listening
	const installed = state?.installation === 'ready'
	const downloading = state?.installation === 'installing'
	const disabled = !listening.supported || listening.loading || listening.busy || !state
	const error = listening.error ?? state?.error
	return (
		<div className="local-speech-settings" id="setting-voice-input">
			<header className="local-speech-heading">
				<Heading>Voice input</Heading>
				<span className="local-speech-badge">On this device</span>
			</header>
			<p className="local-speech-help">
				Talk to Namzu instead of typing. Available in Turkish for now. What you say is turned into
				text on this computer and never sent away as audio.
			</p>
			{!listening.supported ? (
				<p className="local-speech-notice">Voice input is unavailable in this app.</p>
			) : listening.loading ? (
				<output className="local-speech-notice">Loading voice input…</output>
			) : null}
			{state && !installed && (
				<section className="local-speech-engine" aria-label="Download voice input">
					<div>
						<strong>Turkish voice input</strong>
						<span>
							{downloading
								? listeningDownloadStatus(state)
								: `Needs ${approximateDownload(state.downloadBytes)} to download, once.`}
						</span>
						{downloading && (
							<progress
								className="local-speech-progress"
								aria-label="Voice input download"
								max={state.progress?.totalBytes || undefined}
								value={
									state.progress?.step === 'downloading' && state.progress.totalBytes
										? state.progress.downloadedBytes
										: undefined
								}
							/>
						)}
					</div>
				</section>
			)}
			{installed && (
				<>
					<p className="local-speech-help local-speech-location">
						Downloaded and ready. Stored on this device
						{state.diskBytes ? `, ${formatSize(state.diskBytes)}` : ''}.
					</p>
					{onAcceptedChange && (
						<label className="local-speech-toggle">
							<span>
								Let Namzu use the microphone
								<small>Turn off to ask again the next time you press the microphone.</small>
							</span>
							<input
								type="checkbox"
								role="switch"
								className="settings-switch"
								aria-checked={accepted === true}
								checked={accepted === true}
								disabled={accepted === undefined}
								onChange={(event) => onAcceptedChange(event.target.checked)}
							/>
						</label>
					)}
				</>
			)}
			{error && (
				<p className="local-speech-notice local-speech-error" role="alert">
					{error}
				</p>
			)}
			<div className="local-speech-actions">
				{!installed ? (
					downloading ? (
						<Button
							size="sm"
							variant="outline"
							disabled={!listening.supported}
							onClick={() => void listening.cancelInstall()}
						>
							Cancel download
						</Button>
					) : (
						<Button
							size="sm"
							variant="outline"
							disabled={disabled}
							onClick={() => void listening.install()}
						>
							<Download aria-hidden="true" />
							{state?.installation === 'failed' ? 'Try the download again' : 'Download voice input'}
						</Button>
					)
				) : confirmingRemoval ? (
					<>
						<Button
							size="sm"
							variant="destructive-outline"
							disabled={disabled}
							onClick={() => {
								setConfirmingRemoval(false)
								void listening.uninstall()
							}}
						>
							Remove voice input
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setConfirmingRemoval(false)}>
							Keep it
						</Button>
					</>
				) : (
					<Button
						size="sm"
						variant="ghost"
						disabled={disabled}
						onClick={() => setConfirmingRemoval(true)}
					>
						Remove voice input…
					</Button>
				)}
			</div>
		</div>
	)
}
