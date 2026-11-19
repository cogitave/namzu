import { useState } from 'react'
import type { UserMcpServerView } from '../shared/config-lists-protocol.js'
import { ListEditor } from './config-settings-lists.js'
import {
	OPEN_A_PROJECT_FOR_SERVERS,
	type ServerDraft,
	approveLabel,
	changeFromDraft,
	draftFor,
	draftMissing,
	emptyDraft,
	mcpServerRowView,
	mcpServersNote,
	serverConfirmationCopy,
	userServerDetail,
	variablesNote,
	waitingServers,
} from './mcp-servers-model.js'
import { SettingsConfirmDialog } from './settings-confirm-dialog.js'
import { SHOWN_WHEN_READABLE, isSettingsFileError } from './settings-file-error.js'
import { Row } from './settings-row.js'
import { Button } from './ui/button.js'
import type { McpServersControls } from './use-mcp-servers.js'
import type { UserMcpServersControls } from './use-user-mcp-servers.js'

/** The form for one server: its name, then a command with arguments or an address. */
export function ServerForm({
	draft,
	file,
	busy,
	error,
	onChange,
	onSave,
	onCancel,
}: {
	draft: ServerDraft
	file: string | undefined
	busy?: boolean
	error?: string
	onChange: (next: ServerDraft) => void
	onSave: () => void
	onCancel: () => void
}) {
	const [pending, setPending] = useState('')
	const missing =
		draftMissing(draft) ??
		(draft.kind === 'command' && pending.trim() !== ''
			? 'Add the argument you typed, or clear the box.'
			: undefined)
	return (
		<form
			className="mcp-form"
			aria-label={draft.mode === 'add' ? 'Add a tool server' : `Change ${draft.name}`}
			onSubmit={(event) => {
				event.preventDefault()
				if (!missing) onSave()
			}}
		>
			<label className="mcp-form-field">
				<span>Name</span>
				<input
					type="text"
					className="settings-config-input settings-config-wide"
					value={draft.name}
					readOnly={draft.mode === 'edit'}
					placeholder="notes"
					spellCheck={false}
					onChange={(event) => onChange({ ...draft, name: event.target.value })}
				/>
			</label>
			<fieldset className="settings-choices settings-choices-inline">
				<legend className="sr-only">What the server is</legend>
				<label className="settings-choice">
					<input
						type="radio"
						name="mcp-kind"
						checked={draft.kind === 'command'}
						onChange={() => onChange({ ...draft, kind: 'command' })}
					/>
					<span className="settings-choice-label">A program to run</span>
				</label>
				<label className="settings-choice">
					<input
						type="radio"
						name="mcp-kind"
						checked={draft.kind === 'address'}
						onChange={() => onChange({ ...draft, kind: 'address' })}
					/>
					<span className="settings-choice-label">A web address</span>
				</label>
			</fieldset>
			{draft.kind === 'command' ? (
				<>
					<label className="mcp-form-field">
						<span>Command</span>
						<input
							type="text"
							className="settings-config-input settings-config-wide"
							value={draft.command}
							placeholder="npx"
							spellCheck={false}
							onChange={(event) => onChange({ ...draft, command: event.target.value })}
						/>
					</label>
					<div className="mcp-form-field">
						<span>Arguments</span>
						<ListEditor
							label="Arguments"
							itemLabel="argument"
							placeholder="-y"
							items={draft.args}
							onPending={setPending}
							onChange={(args) => {
								onChange({ ...draft, args })
								return undefined
							}}
						/>
					</div>
				</>
			) : (
				<label className="mcp-form-field">
					<span>Address</span>
					<input
						type="text"
						className="settings-config-input settings-config-wide"
						value={draft.url}
						placeholder="https://example.com/mcp"
						spellCheck={false}
						onChange={(event) => onChange({ ...draft, url: event.target.value })}
					/>
				</label>
			)}
			<p className="settings-note">{variablesNote(file)}</p>
			{pending.trim() !== '' && draft.kind === 'command' && (
				<p className="settings-note">{missing}</p>
			)}
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}
			<span className="settings-config-field">
				<Button variant="outline" size="sm" type="submit" disabled={busy || missing !== undefined}>
					{draft.mode === 'add' ? 'Add server' : 'Save server'}
				</Button>
				<Button variant="ghost-muted" size="sm" onClick={onCancel}>
					Cancel
				</Button>
			</span>
		</form>
	)
}

/** One line of the list a person can change: Edit and Remove, and the question before a removal. */
function OwnActions({
	own,
	server,
	removing,
	onEdit,
	onAskRemove,
	onRemove,
	onKeep,
}: {
	own: UserMcpServersControls
	server: UserMcpServerView
	removing: boolean
	onEdit: () => void
	onAskRemove: () => void
	onRemove: () => void
	onKeep: () => void
}) {
	if (removing)
		return (
			<span className="settings-config-field">
				<span className="settings-note">
					Remove {server.name}? Its variables and headers in the file go with it.
				</span>
				<Button variant="outline" size="xs" disabled={own.busy} onClick={onRemove}>
					Remove
				</Button>
				<Button variant="ghost-muted" size="xs" onClick={onKeep}>
					Keep
				</Button>
			</span>
		)
	return (
		<span className="settings-config-field">
			{server.kind !== 'other' && (
				<Button variant="ghost-muted" size="xs" aria-label={`Edit ${server.name}`} onClick={onEdit}>
					Edit
				</Button>
			)}
			<Button
				variant="ghost-muted"
				size="xs"
				aria-label={`Remove ${server.name}`}
				onClick={onAskRemove}
			>
				Remove
			</Button>
		</span>
	)
}

/**
 * The tool servers: the project's, read from the engine (where each is defined and where it
 * stands, with Approve for the ones a project's `.mcp.json` asks to start), and the ones in the
 * person's own settings, which can be added, changed and removed here. Variables and headers are
 * never read into this window.
 */
export function McpServersRows({
	servers,
	own,
	projectName,
}: {
	servers: McpServersControls
	own?: UserMcpServersControls
	projectName?: string
}) {
	const [draft, setDraft] = useState<ServerDraft>()
	const [removing, setRemoving] = useState<string>()
	const ownByName = new Map((own?.view?.servers ?? []).map((server) => [server.name, server]))
	const file = own?.view?.file
	const dialog = own?.confirmation && (
		<SettingsConfirmDialog
			onConfirm={async () => {
				if (await own.confirm()) setDraft(undefined)
			}}
			onCancel={own.dismiss}
			copy={serverConfirmationCopy(own.confirmation.message)}
		/>
	)
	const form = own && draft && (
		<ServerForm
			draft={draft}
			file={file}
			busy={own.busy}
			error={own.error}
			onChange={(next) => {
				own.clearError()
				setDraft(next)
			}}
			onSave={() =>
				void own.save(changeFromDraft(draft)).then((saved) => saved && setDraft(undefined))
			}
			onCancel={() => {
				own.clearError()
				setDraft(undefined)
			}}
		/>
	)
	const addButton = own && !draft && (
		<span className="settings-config-field">
			<Button variant="outline" size="sm" onClick={() => setDraft(emptyDraft())}>
				Add server
			</Button>
		</span>
	)
	const actions = (name: string) => {
		const held = ownByName.get(name)
		return own && held ? (
			<OwnActions
				own={own}
				server={held}
				removing={removing === name}
				onEdit={() => {
					own.clearError()
					void own.open(name).then((whole) => whole && setDraft(draftFor(whole)))
				}}
				onAskRemove={() => setRemoving(name)}
				onRemove={() => void own.remove(name).then((done) => done && setRemoving(undefined))}
				onKeep={() => setRemoving(undefined)}
			/>
		) : null
	}
	const ownError = own?.error && !draft ? own.error : undefined
	// The row stays when no project is open, and says why it has nothing to show of the project's.
	if (!servers.supported)
		return (
			<Row id="mcpServers" label="Tool servers" description={mcpServersNote(projectName)} stacked>
				<div className="mcp-servers">
					<p className="settings-note">{OPEN_A_PROJECT_FOR_SERVERS}</p>
					{own?.view && own.view.servers.length > 0 && (
						<ul className="mcp-server-list" aria-label="Your tool servers">
							{own.view.servers.map((server) => (
								<li key={server.name} className="mcp-server">
									<div className="mcp-server-main">
										<span className="mcp-server-name">{server.name}</span>
										<span className="mcp-server-where">
											Your own settings
											{userServerDetail(server) ? ` · ${userServerDetail(server)}` : ''}
										</span>
									</div>
									{actions(server.name)}
								</li>
							))}
						</ul>
					)}
					{ownError && (
						<p role="alert" className="settings-error">
							{ownError}
						</p>
					)}
					{form}
					{addButton}
					{own && !draft && <p className="settings-note">{variablesNote(file)}</p>}
					{dialog}
				</div>
			</Row>
		)
	const waiting = waitingServers(servers.view)
	// A broken settings file is said once, at the top of the page; this list waits for it.
	const fileBroken = isSettingsFileError(servers.error) || isSettingsFileError(servers.view?.error)
	const rows = (servers.view?.servers ?? []).map(mcpServerRowView)
	return (
		<Row id="mcpServers" label="Tool servers" description={mcpServersNote(projectName)} stacked>
			<div className="mcp-servers">
				{servers.loading && !servers.view && (
					<p className="settings-note">Reading the tool servers…</p>
				)}
				{fileBroken && <p className="settings-note">{SHOWN_WHEN_READABLE}</p>}
				{servers.error && !fileBroken && (
					<p role="alert" className="settings-error">
						{servers.error}
					</p>
				)}
				{servers.view?.error && !fileBroken && (
					<p role="alert" className="settings-error">
						{servers.view.error}
					</p>
				)}
				{waiting.length > 0 && (
					<div className="mcp-waiting">
						<p>
							{waiting.length === 1
								? 'A tool server from this project’s .mcp.json is waiting for your approval and has not started.'
								: `${waiting.length} tool servers from this project’s .mcp.json are waiting for your approval and have not started.`}{' '}
							Approving lets them run the programs listed below on your computer.
						</p>
						<Button
							variant="outline"
							size="sm"
							disabled={servers.approving}
							onClick={() => void servers.approve()}
						>
							{approveLabel(waiting.length)}
						</Button>
					</div>
				)}
				{rows.length === 0 &&
					!servers.loading &&
					!servers.error &&
					!servers.view?.error &&
					!fileBroken && (
						<p className="settings-note">No tool servers are set up for this project.</p>
					)}
				{rows.length > 0 && (
					<ul className="mcp-server-list" aria-label="Tool server list">
						{rows.map((row) => (
							<li key={row.name} className="mcp-server" data-state={row.state}>
								<div className="mcp-server-main">
									<span className="mcp-server-name">{row.name}</span>
									<span className="mcp-server-where">
										{row.where}
										{row.detail ? ` · ${row.detail}` : ''}
									</span>
									{row.reason && <span className="mcp-server-reason">{row.reason}</span>}
								</div>
								<span className="settings-badge" data-tone={row.state}>
									{row.stateLabel}
								</span>
								{row.origin === 'your-config' && actions(row.name)}
							</li>
						))}
					</ul>
				)}
				{ownError && (
					<p role="alert" className="settings-error">
						{ownError}
					</p>
				)}
				{form}
				{addButton}
				{own && !draft && <p className="settings-note">{variablesNote(file)}</p>}
				{dialog}
			</div>
		</Row>
	)
}
