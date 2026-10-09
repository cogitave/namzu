import { LoaderCircle } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import type { ProviderConnectionView } from '../shared/protocol.js'
import {
	ZEN_KEY_URL,
	connectedCount,
	connectionStatus,
	keyProblem,
	testOutcome,
} from './provider-connections-model.js'
import { Button } from './ui/button.js'
import type { ProviderConnectionsControls } from './use-provider-connections.js'
import './models-section.css'

/**
 * Settings ▸ Models: which providers Namzu can answer with, how each is connected, and the one
 * place a first-timer pastes a key. A pasted key lives in this component only while the box is
 * open: it is cleared the moment it is sent and is never returned, shown again or logged.
 */
export function ModelsSection({ connections }: { connections: ProviderConnectionsControls }) {
	const heading = useId()
	const { rows, loading, error, supported } = connections
	if (!supported)
		return (
			<p className="settings-empty">
				This version of Namzu can’t connect providers from here. Update Namzu, then come back.
			</p>
		)
	return (
		<div id="setting-models" className="models-section">
			<p className="settings-help" id={heading}>
				{connectedCount(rows) > 0
					? 'Namzu answers with the providers marked connected.'
					: 'Namzu needs one connected provider before it can answer. Paste an API key below, or sign in with Claude Code or Codex and Namzu will find that sign-in.'}{' '}
				Keys stay on this computer, in Namzu’s private folder.
			</p>
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}
			{loading && rows.length === 0 ? (
				<p className="settings-empty">Looking for your providers…</p>
			) : (
				<ul className="models-list" aria-labelledby={heading}>
					{rows.map((row) => (
						<ProviderRow key={row.id} row={row} connections={connections} />
					))}
				</ul>
			)}
		</div>
	)
}

function ProviderRow({
	row,
	connections,
}: { row: ProviderConnectionView; connections: ProviderConnectionsControls }) {
	const inputId = useId()
	const messageId = useId()
	const input = useRef<HTMLInputElement>(null)
	const opener = useRef<HTMLButtonElement>(null)
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState('')
	const [problem, setProblem] = useState<string>()
	const [outcome, setOutcome] = useState<{ text: string; tone: 'good' | 'bad' | 'quiet' }>()
	const busy = connections.busy === row.id
	const anyBusy = connections.busy !== undefined
	const connected = row.state === 'connected'

	const close = () => {
		setEditing(false)
		setDraft('')
		setProblem(undefined)
		// The button that opened the box is back after it closes; put focus there.
		queueMicrotask(() => opener.current?.focus())
	}
	const check = async () => {
		setOutcome(undefined)
		const result = await connections.test(row.id)
		if (result) setOutcome(testOutcome(result, row.label))
	}
	const submit = async () => {
		const found = keyProblem(draft)
		if (found) {
			setProblem(found)
			input.current?.focus()
			return
		}
		// Take the key out of component state before anything is awaited.
		const key = draft
		setDraft('')
		setProblem(undefined)
		setOutcome(undefined)
		const saved = await connections.save(row.id, key)
		if (!saved) {
			// The error line says why; the box stays so the person can paste again.
			input.current?.focus()
			return
		}
		close()
		await check()
	}
	return (
		<li className="models-row" data-state={row.state}>
			<div className="models-row-main">
				<div className="models-row-copy">
					<h3 className="models-row-name">{row.label}</h3>
					<p className="models-row-status" data-state={row.state}>
						{connectionStatus(row)}
					</p>
					{row.state !== 'connected' && row.help && <p className="models-row-help">{row.help}</p>}
				</div>
				<div className="models-row-actions">
					{connected && (
						<Button
							size="sm"
							variant="outline"
							disabled={anyBusy}
							aria-label={`Check the connection to ${row.label}`}
							onClick={() => void check()}
						>
							{busy && !editing ? (
								<LoaderCircle
									aria-hidden="true"
									className="animate-spin motion-reduce:animate-none"
								/>
							) : null}
							Check
						</Button>
					)}
					{row.canSaveKey && !editing && (
						<Button
							ref={opener}
							size="sm"
							variant={connected ? 'outline' : 'default'}
							disabled={anyBusy}
							aria-label={
								row.hasSavedKey
									? `Replace the API key for ${row.label}`
									: `Add an API key for ${row.label}`
							}
							onClick={() => {
								setOutcome(undefined)
								setEditing(true)
								queueMicrotask(() => input.current?.focus())
							}}
						>
							{row.hasSavedKey ? 'Replace key' : 'Add key'}
						</Button>
					)}
					{row.state === 'free' &&
						!editing &&
						typeof window !== 'undefined' &&
						window.namzu?.openExternal && (
							<Button
								size="sm"
								variant="outline"
								aria-label={`Open the page where you get a free key for ${row.label}`}
								onClick={() => void window.namzu?.openExternal?.(ZEN_KEY_URL).catch(() => {})}
							>
								Get a free key
							</Button>
						)}
					{row.hasSavedKey && !editing && (
						<Button
							size="sm"
							variant="outline"
							disabled={anyBusy}
							aria-label={`Remove the saved API key for ${row.label}`}
							onClick={() =>
								void connections.remove(row.id).then((removed) => {
									if (removed) setOutcome({ text: 'The saved key was removed.', tone: 'quiet' })
								})
							}
						>
							Remove key
						</Button>
					)}
				</div>
			</div>
			{editing && (
				<form
					className="models-key-form"
					onSubmit={(event) => {
						event.preventDefault()
						void submit()
					}}
				>
					<label htmlFor={inputId} className="models-key-label">
						{row.label} API key
					</label>
					<div className="models-key-controls">
						<input
							ref={input}
							id={inputId}
							type="password"
							className="models-key-input"
							autoComplete="off"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							value={draft}
							disabled={busy}
							aria-invalid={problem ? true : undefined}
							aria-describedby={problem ? messageId : undefined}
							onChange={(event) => {
								setDraft(event.target.value)
								if (problem) setProblem(undefined)
							}}
							onKeyDown={(event) => {
								if (event.key === 'Escape') {
									event.stopPropagation()
									close()
								}
							}}
						/>
						<Button type="submit" size="sm" disabled={busy || draft.length === 0}>
							{busy ? (
								<LoaderCircle
									aria-hidden="true"
									className="animate-spin motion-reduce:animate-none"
								/>
							) : null}
							Save key
						</Button>
						<Button type="button" size="sm" variant="ghost-muted" disabled={busy} onClick={close}>
							Cancel
						</Button>
					</div>
					{problem && (
						<p id={messageId} role="alert" className="models-key-problem">
							{problem}
						</p>
					)}
				</form>
			)}
			<output className="models-row-result" data-tone={outcome?.tone} aria-live="polite">
				{outcome?.text}
			</output>
		</li>
	)
}
