import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useRef, useState } from 'react'
import type { SavedMemory } from '../shared/memory-protocol.js'
import { catalogueEntry } from '../shared/settings-catalogue.js'
import {
	DELETE_COPY,
	INSTRUCTIONS_CHANGED,
	filterMemories,
	instructionsNote,
	instructionsToSave,
	originText,
	outcomeProblem,
	stateText,
} from './memory-view-model.js'
import { plainErrorText } from './plain-error.js'
import { SettingsConfirmDialog } from './settings-confirm-dialog.js'
import { Row } from './settings-row.js'
import { Button } from './ui/button.js'
import type { InstructionsControls, SavedMemoryControls } from './use-memory-controls.js'

/**
 * Settings ▸ Agent ▸ Memory, the rows that are the person's own text: standing instructions and
 * the saved memories of the open project. Both are the files the terminal app reads. Nothing here
 * starts a model, and nothing leaves the computer.
 */
export function MemoryRows({
	instructions,
	memory,
	projectName,
	hasProject,
}: {
	instructions: InstructionsControls
	memory: SavedMemoryControls & { open: boolean; setOpen(open: boolean): void }
	projectName?: string
	hasProject: boolean
}) {
	return (
		<>
			{instructions.supported && <InstructionsRow instructions={instructions} />}
			{memory.supported && (
				<ManageMemoryRow memory={memory} projectName={projectName} hasProject={hasProject} />
			)}
		</>
	)
}

function InstructionsRow({ instructions }: { instructions: InstructionsControls }) {
	const entry = catalogueEntry('standingInstructions')
	const saved = instructions.view?.text ?? ''
	const limit = instructions.view?.limit ?? 32_000
	const locked = instructions.view?.locked === true
	const [draft, setDraft] = useState<string>()
	const [failure, setFailure] = useState<string>()
	const [status, setStatus] = useState<string>()
	const text = draft ?? saved
	const commit = async () => {
		if (draft === undefined) return
		const next = instructionsToSave(draft, saved)
		if (next === undefined) return setDraft(undefined)
		setFailure(undefined)
		setStatus(undefined)
		try {
			const result = await instructions.save(next)
			if (result === 'saved') {
				setDraft(undefined)
				setStatus('Saved')
			} else if (result === 'changed') {
				setDraft(undefined)
				setFailure(INSTRUCTIONS_CHANGED)
			}
		} catch (error) {
			setFailure(plainErrorText(error, 'save your instructions'))
		}
	}
	return (
		<Row id={entry.id} label={entry.label} description={entry.description} stacked>
			<div className="settings-config-control">
				<textarea
					className="settings-config-input settings-config-area settings-config-prose"
					aria-label={entry.label}
					value={text}
					rows={Math.min(10, Math.max(4, text.split('\n').length))}
					maxLength={limit}
					disabled={locked || instructions.loading}
					placeholder="For example: keep explanations brief and to the point"
					onChange={(event) => {
						setStatus(undefined)
						setDraft(event.target.value)
					}}
					onBlur={() => void commit()}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void commit()
					}}
				/>
				<p className="settings-note">
					{locked
						? 'Your instructions file is a link or a folder, so it can only be changed by hand.'
						: instructionsNote(text.length, limit)}
				</p>
				<output aria-live="polite" className="settings-note">
					{status}
				</output>
				{(failure ?? instructions.error) && (
					<p role="alert" className="settings-error settings-config-error">
						{failure ?? instructions.error}
					</p>
				)}
			</div>
		</Row>
	)
}

function ManageMemoryRow({
	memory,
	projectName,
	hasProject,
}: {
	memory: SavedMemoryControls & { open: boolean; setOpen(open: boolean): void }
	projectName?: string
	hasProject: boolean
}) {
	const entry = catalogueEntry('savedMemory')
	return (
		<Row
			id={entry.id}
			label={entry.label}
			description={entry.description}
			meta={
				hasProject
					? projectName
						? `Showing what is saved for ${projectName}.`
						: undefined
					: 'Open a project to see what is saved for it.'
			}
		>
			<Button
				variant="outline"
				size="sm"
				disabled={!hasProject}
				onClick={() => memory.setOpen(true)}
			>
				Manage
			</Button>
			{memory.open && <MemoryDialog memory={memory} projectName={projectName} />}
		</Row>
	)
}

function MemoryDialog({
	memory,
	projectName,
}: {
	memory: SavedMemoryControls & { setOpen(open: boolean): void }
	projectName?: string
}) {
	const [query, setQuery] = useState('')
	const [openId, setOpenId] = useState<string>()
	const memories = memory.view?.memories ?? []
	const shown = filterMemories(memories, query)
	const current = memories.find((item) => item.id === openId)
	const items = useRef(new Map<string, HTMLButtonElement>())
	const search = useRef<HTMLInputElement>(null)
	const lastOpened = useRef<string | undefined>(undefined)
	if (openId) lastOpened.current = openId
	// Back to the list puts focus on the memory that was open, or on the search box.
	useEffect(() => {
		if (current) return
		const id = lastOpened.current
		const target = (id ? items.current.get(id) : undefined) ?? search.current
		target?.focus()
	}, [current])
	return (
		<Dialog.Root open onOpenChange={(open) => !open && memory.setOpen(false)}>
			<Dialog.Portal>
				<Dialog.Backdrop className="dialog-scrim" />
				<Dialog.Viewport className="dialog-viewport">
					<Dialog.Popup className="dialog-popup memory-dialog" data-memory-dialog>
						<Dialog.Title className="dialog-title">
							{catalogueEntry('savedMemory').label}
						</Dialog.Title>
						{current ? (
							<MemoryEditor
								key={current.id + current.revision}
								item={current}
								memory={memory}
								onClose={() => setOpenId(undefined)}
							/>
						) : (
							<>
								<Dialog.Description className="dialog-body">
									{projectName
										? `What Namzu has saved for ${projectName}.`
										: 'What Namzu has saved for this project.'}{' '}
									Open one to edit it or delete it.
								</Dialog.Description>
								<input
									type="search"
									className="settings-config-input memory-search"
									ref={search}
									aria-label="Search memory"
									placeholder="Search"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
								/>
								{memory.loading && !memory.view && <p className="settings-note">Reading…</p>}
								{memory.error && (
									<p role="alert" className="settings-error">
										{memory.error}
									</p>
								)}
								{memory.view && memories.length === 0 && (
									<p className="settings-note">Nothing is saved for this project yet.</p>
								)}
								{memories.length > 0 && shown.length === 0 && (
									<p className="settings-note">Nothing matches your search.</p>
								)}
								<ul className="memory-list">
									{shown.map((item) => (
										<li key={item.id}>
											<button
												type="button"
												className="memory-item"
												ref={(node) => {
													if (node) items.current.set(item.id, node)
													else items.current.delete(item.id)
												}}
												onClick={() => setOpenId(item.id)}
											>
												<span className="memory-item-title">{item.title}</span>
												<span className="memory-item-meta">
													{[originText(item.origin), stateText(item.state)]
														.filter(Boolean)
														.join(' · ')}
												</span>
												{item.excerpt && (
													<span className="memory-item-excerpt">{item.excerpt}</span>
												)}
											</button>
										</li>
									))}
								</ul>
							</>
						)}
						{!current && (
							<div className="dialog-actions">
								<Button variant="outline" onClick={() => memory.setOpen(false)}>
									Close
								</Button>
							</div>
						)}
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}

function MemoryEditor({
	item,
	memory,
	onClose,
}: {
	item: SavedMemory
	memory: SavedMemoryControls
	onClose(): void
}) {
	const [title, setTitle] = useState(item.title)
	const [text, setText] = useState<string>()
	const [revision, setRevision] = useState(item.revision)
	const [problem, setProblem] = useState<string>()
	const [busy, setBusy] = useState(false)
	const [asking, setAsking] = useState(false)
	const [original, setOriginal] = useState<string>()
	const titleInput = useRef<HTMLInputElement>(null)
	useEffect(() => {
		titleInput.current?.focus()
	}, [])
	// The whole text is read when it opens: the list carries only the start of it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: read once for this memory and version
	useEffect(() => {
		let live = true
		memory.read(item.id).then(
			(detail) => {
				if (!live) return
				if (!detail.found) return setProblem('This memory is already gone.')
				setText(detail.text)
				setOriginal(detail.text)
				setRevision(detail.revision)
			},
			(failure) => live && setProblem(plainErrorText(failure, 'open this memory')),
		)
		return () => {
			live = false
		}
	}, [item.id])
	const changed = text !== undefined && (title !== item.title || text !== original)
	const save = async () => {
		if (text === undefined || busy) return
		setBusy(true)
		setProblem(undefined)
		try {
			const outcome = await memory.update({
				id: item.id,
				revision,
				text,
				...(title !== item.title ? { title } : {}),
			})
			const refused = outcomeProblem(outcome)
			if (refused) setProblem(refused)
			else {
				memory.reload()
				onClose()
			}
		} catch (failure) {
			setProblem(plainErrorText(failure, 'save this memory'))
		} finally {
			setBusy(false)
		}
	}
	const remove = async () => {
		const outcome = await memory.remove({ id: item.id, revision })
		const refused = outcome === 'gone' ? undefined : outcomeProblem(outcome)
		if (refused) {
			setAsking(false)
			setProblem(refused)
			return
		}
		memory.reload()
		onClose()
	}
	return (
		<div className="memory-editor">
			<Dialog.Description className="dialog-body">
				Change the title or text, or delete this memory.
			</Dialog.Description>
			<p className="settings-note">
				{[originText(item.origin), stateText(item.state)].filter(Boolean).join(' · ')}
			</p>
			<input
				type="text"
				ref={titleInput}
				className="settings-config-input memory-title"
				aria-label="Title"
				value={title}
				maxLength={120}
				onChange={(event) => setTitle(event.target.value)}
			/>
			<textarea
				className="settings-config-input settings-config-area"
				aria-label="Memory"
				rows={8}
				value={text ?? ''}
				maxLength={8000}
				disabled={text === undefined}
				onChange={(event) => setText(event.target.value)}
			/>
			{problem && (
				<p role="alert" className="settings-error">
					{problem}
				</p>
			)}
			<div className="dialog-actions">
				<Button variant="destructive" disabled={busy} onClick={() => setAsking(true)}>
					Delete
				</Button>
				<Button variant="outline" disabled={busy} onClick={onClose}>
					Back
				</Button>
				<Button
					disabled={
						busy || !changed || text === undefined || text.trim() === '' || title.trim() === ''
					}
					onClick={() => void save()}
				>
					Save
				</Button>
			</div>
			{asking && (
				<SettingsConfirmDialog
					copy={DELETE_COPY}
					onConfirm={remove}
					onCancel={() => setAsking(false)}
				/>
			)}
		</div>
	)
}
