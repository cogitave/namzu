import { Dialog } from '@base-ui/react/dialog'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
	SkillPathChoiceView,
	SkillScope,
	SkillStageView,
} from '../shared/customize-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import {
	CONNECTOR_INTRO,
	CONNECTOR_NAME_HELP,
	CONNECTOR_NOTICE,
	CONNECTOR_URL_HELP,
	type CardState,
	type ConnectorAuth,
	type ConnectorProblems,
	DESCRIPTION_MAX,
	FRONTMATTER_NOTE,
	PROJECT_UNTRUSTED,
	SCOPES,
	UPLOAD_CHECKED_LINE,
	UPLOAD_DROP_TEXT,
	UPLOAD_HELP,
	UPLOAD_LIMIT,
	UPLOAD_SUBTITLE,
	XML_DESCRIPTION_PROBLEM,
	collisionLine,
	connectorChange,
	connectorProblem,
	connectorProblems,
	createProblem,
	emptyConnector,
	skillFolderName,
	stageChips,
	stageNeedsAccept,
	stageSize,
	startsWithFrontmatter,
	uploadBlocked,
	uploadToast,
} from './customize-actions-model.js'
import { Chip, DetailFrame, Tile } from './customize-parts.js'
import { FileIcon, XIcon } from './icons.js'
import { notify } from './notify.js'
import { plainErrorText } from './plain-error.js'
import { SKILLS_CHANGED_EVENT } from './skill-create.js'
import { Button } from './ui/button.js'

/** The pieces of the three actions on the Customize page that add something: a page and two dialogs. */

type UploadApi = Pick<
	DesktopApi,
	'chooseSkillFiles' | 'chooseSkillFolder' | 'dropSkillFiles' | 'stageSkills' | 'installSkills'
>

function ScopePicker({
	scope,
	onScope,
	projectReady,
}: {
	scope: SkillScope
	onScope: (scope: SkillScope) => void
	projectReady: boolean
}) {
	const name = useId()
	return (
		<fieldset className="customize-fieldset">
			<legend className="customize-field-label">Where to save</legend>
			<div className="customize-segments">
				{SCOPES.map((item) => {
					const off = item.id === 'project' && !projectReady
					return (
						<label
							key={item.id}
							className="customize-segment"
							data-disabled={off || undefined}
							title={off ? PROJECT_UNTRUSTED : undefined}
						>
							<input
								type="radio"
								name={name}
								checked={scope === item.id}
								disabled={off}
								onChange={() => onScope(item.id)}
							/>
							<span>{item.label}</span>
						</label>
					)
				})}
			</div>
			{!projectReady && <p className="customize-hint">{PROJECT_UNTRUSTED}</p>}
		</fieldset>
	)
}

export function StageCard({
	card,
	scope,
	failure,
	replace,
	accept,
	onReplace,
	onAccept,
	onRemove,
}: {
	card: CardState
	scope: SkillScope
	failure?: string
	replace: boolean
	accept: boolean
	onReplace: (on: boolean) => void
	onAccept: (on: boolean) => void
	onRemove: () => void
}) {
	const item = card.item
	const error = card.error ?? item?.error ?? failure
	const chips = item ? stageChips(item) : []
	const collision = item ? collisionLine(item, scope) : undefined
	const lines = item ? [...item.grants, ...item.findings] : []
	return (
		<li className="customize-stage" data-failed={error ? true : undefined}>
			<Tile icon={FileIcon} />
			<div className="customize-stage-copy">
				<div className="customize-row-title">
					<span className="customize-name" title={item?.name ?? card.choice.fileName}>
						{item?.name ?? card.choice.fileName}
					</span>
					{chips.map((chip) => (
						<Chip key={chip}>{chip}</Chip>
					))}
				</div>
				{item?.description && <p className="customize-stage-sub">{item.description}</p>}
				{item && !error && <p className="customize-stage-meta">{stageSize(item)}</p>}
				{error && (
					<p className="customize-stage-error" role="alert">
						{error}
					</p>
				)}
				{lines.length > 0 && (
					<ul className="customize-stage-lines">
						{lines.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				)}
				{collision && (
					<label className="customize-check">
						<input
							type="checkbox"
							checked={replace}
							onChange={(event) => onReplace(event.target.checked)}
						/>
						<span>{collision}</span>
					</label>
				)}
				{item && !error && stageNeedsAccept(item) && (
					<label className="customize-check">
						<input
							type="checkbox"
							checked={accept}
							onChange={(event) => onAccept(event.target.checked)}
						/>
						<span>I trust what it can run</span>
					</label>
				)}
			</div>
			<button type="button" className="customize-stage-remove" onClick={onRemove}>
				Remove from list
			</button>
		</li>
	)
}

/** What a yes was given to: the name alone cannot tell two files of that name apart. */
const itemSignature = (item: SkillStageView['items'][number]): string =>
	[item.fileName, item.kind, item.files, item.bytes, item.description].join('\0')

/** The page behind Add, Upload skill: choose files, read what each would do, then add them. */
export function UploadSkillPage({
	api,
	projectId,
	onBack,
	onDone,
}: {
	api: UploadApi
	projectId?: string
	onBack: () => void
	onDone: () => void
}) {
	const [choices, setChoices] = useState<SkillPathChoiceView[]>([])
	const [stage, setStage] = useState<SkillStageView>()
	const [scope, setScope] = useState<SkillScope>('user')
	const [replace, setReplace] = useState<ReadonlySet<string>>(() => new Set())
	const [accept, setAccept] = useState<ReadonlySet<string>>(() => new Set())
	const [failures, setFailures] = useState<Readonly<Record<string, string>>>({})
	const [problem, setProblem] = useState<string>()
	const [busy, setBusy] = useState(false)
	const [over, setOver] = useState(false)
	const live = useRef(true)
	const latest = useRef(0)
	const acceptedFor = useRef(new Map<string, string>())
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
		}
	}, [])

	const reading = useCallback(
		async (next: SkillPathChoiceView[]) => {
			const mine = ++latest.current
			setChoices(next)
			setStage(undefined)
			const paths = next.flatMap((choice) => (choice.path ? [choice.path] : []))
			if (paths.length === 0 || !api.stageSkills) return
			try {
				const answer = await api.stageSkills(paths, projectId)
				if (live.current && latest.current === mine) {
					if (answer) {
						setStage(answer)
						// A yes holds only for the same file it was given to; anything else asks again.
						setAccept((all) => {
							const kept = new Set<string>()
							for (const name of all) {
								const item = answer.items.find((other) => other.name === name)
								if (item && acceptedFor.current.get(name) === itemSignature(item)) kept.add(name)
							}
							return kept
						})
					} else setProblem('Update Namzu to add skills from here.')
				}
			} catch (failure) {
				if (live.current && latest.current === mine)
					setProblem(plainErrorText(failure, 'read the skills'))
			}
		},
		[api, projectId],
	)

	const add = async (picked: SkillPathChoiceView[]) => {
		setProblem(undefined)
		const seen = new Set(choices.map((choice) => choice.path ?? choice.fileName))
		const fresh = picked.filter((choice) => !seen.has(choice.path ?? choice.fileName))
		const all = [...choices, ...fresh]
		if (all.length > UPLOAD_LIMIT) {
			setProblem(`You can upload up to ${UPLOAD_LIMIT} skill files at a time.`)
			return
		}
		if (fresh.length > 0) await reading(all)
	}
	const pick = (choose: (() => Promise<SkillPathChoiceView[]>) | undefined) => async () => {
		if (!choose) return
		try {
			await add(await choose())
		} catch (failure) {
			setProblem(plainErrorText(failure, 'choose the files'))
		}
	}

	// A card per choice: the choices with a path line up with the engine's items in order.
	const cards: CardState[] = useMemo(() => {
		let index = 0
		return choices.map((choice) => {
			if (!choice.path) return { choice, error: choice.error ?? 'That file cannot be used.' }
			const item = stage?.items[index++]
			return item ? { choice, item } : { choice }
		})
	}, [choices, stage])
	const reasonBlocked = uploadBlocked(cards, scope, replace, accept)
	const toggle = (set: ReadonlySet<string>, name: string, on: boolean) => {
		const next = new Set(set)
		if (on) next.add(name)
		else next.delete(name)
		return next
	}

	const upload = async () => {
		if (!stage || !api.installSkills || busy || reasonBlocked) return
		setBusy(true)
		setProblem(undefined)
		try {
			const answer = await api.installSkills(
				{ stageId: stage.stageId, scope, replace: [...replace], accept: [...accept] },
				projectId,
			)
			if (!live.current) return
			if (!answer) {
				setProblem('Update Namzu to add skills from here.')
				return
			}
			const toast = uploadToast(answer.results)
			notify(toast.text, { tone: toast.tone })
			window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT))
			const added = new Set(answer.results.filter((r) => r.outcome !== 'failed').map((r) => r.name))
			const left = cards.filter((card) => !(card.item?.name && added.has(card.item.name)))
			if (left.length === 0 || answer.results.every((r) => r.outcome !== 'failed')) {
				onDone()
				return
			}
			setFailures(
				Object.fromEntries(
					answer.results.flatMap((r) =>
						r.outcome === 'failed' && r.error ? [[r.name, r.error]] : [],
					),
				),
			)
			await reading(left.map((card) => card.choice))
		} catch (failure) {
			if (live.current) setProblem(plainErrorText(failure, 'add the skills'))
		} finally {
			if (live.current) setBusy(false)
		}
	}

	return (
		<DetailFrame
			backLabel="Your skills"
			onBack={onBack}
			tile={<Tile icon={FileIcon} size={44} />}
			title="Upload a skill"
			subtitle={UPLOAD_SUBTITLE}
		>
			<div className="customize-upload">
				<h3 className="customize-field-label" id="skill-file-label">
					Skill file
				</h3>
				<section
					className="customize-drop"
					aria-labelledby="skill-file-label"
					data-over={over || undefined}
					onDragOver={(event) => {
						event.preventDefault()
						setOver(true)
					}}
					onDragLeave={() => setOver(false)}
					onDrop={(event) => {
						event.preventDefault()
						setOver(false)
						void (async () => {
							try {
								await add((await api.dropSkillFiles?.(Array.from(event.dataTransfer.files))) ?? [])
							} catch (failure) {
								setProblem(plainErrorText(failure, 'read the dropped files'))
							}
						})()
					}}
				>
					<p>
						{UPLOAD_DROP_TEXT.split('browse').map((part, index, all) =>
							index < all.length - 1 ? (
								<span key={part}>
									{part}
									<button
										type="button"
										className="customize-link"
										onClick={() => void pick(api.chooseSkillFiles)()}
									>
										browse
									</button>
								</span>
							) : (
								part
							),
						)}
					</p>
					<button
						type="button"
						className="customize-link"
						onClick={() => void pick(api.chooseSkillFolder)()}
					>
						Choose a folder
					</button>
				</section>
				{UPLOAD_HELP.map((line) => (
					<p key={line} className="customize-hint">
						{line}
					</p>
				))}
				{cards.length > 0 && (
					<ul className="customize-stages" aria-label="Skills to add">
						{cards.map((card, index) => (
							<StageCard
								key={card.choice.path ?? `${card.choice.fileName}:${index}`}
								card={card}
								scope={scope}
								failure={card.item?.name ? failures[card.item.name] : undefined}
								replace={Boolean(card.item?.name && replace.has(card.item.name))}
								accept={Boolean(card.item?.name && accept.has(card.item.name))}
								onReplace={(on) =>
									card.item?.name && setReplace((all) => toggle(all, card.item?.name ?? '', on))
								}
								onAccept={(on) => {
									const item = card.item
									if (!item?.name) return
									if (on) acceptedFor.current.set(item.name, itemSignature(item))
									setAccept((all) => toggle(all, item.name ?? '', on))
								}}
								onRemove={() => void reading(choices.filter((other) => other !== card.choice))}
							/>
						))}
					</ul>
				)}
				<ScopePicker scope={scope} onScope={setScope} projectReady={Boolean(projectId)} />
				<p className="customize-hint">{UPLOAD_CHECKED_LINE}</p>
				{problem && (
					<p className="customize-error" role="alert">
						{problem}
					</p>
				)}
				<div className="customize-actions">
					<Button
						className="customize-primary"
						disabled={Boolean(reasonBlocked) || busy}
						onClick={() => void upload()}
					>
						{busy ? 'Adding…' : 'Upload'}
					</Button>
					<Button variant="outline" onClick={onBack}>
						Cancel
					</Button>
					{reasonBlocked && <span className="customize-hint">{reasonBlocked}</span>}
				</div>
			</div>
		</DetailFrame>
	)
}

/** The first field of the open dialog, so the focus starts where typing starts. */
const firstField = (): HTMLElement | null =>
	document.querySelector<HTMLElement>('.customize-dialog [data-autofocus]')

function Overlay({
	title,
	children,
	onClose,
	returnFocus,
	size = 'form',
	locked = false,
}: {
	title: string
	children: React.ReactNode
	onClose: () => void
	returnFocus: () => HTMLElement | null
	size?: 'form' | 'wide'
	/** A request is running: Escape, the backdrop and the X wait, as Cancel does. */
	locked?: boolean
}) {
	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open && !locked) onClose()
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="dialog-scrim" />
				<Dialog.Viewport className="dialog-viewport">
					<Dialog.Popup
						className="dialog-popup customize-dialog"
						data-size={size}
						initialFocus={firstField}
						finalFocus={returnFocus}
					>
						<header className="customize-dialog-head">
							<Dialog.Title className="dialog-title">{title}</Dialog.Title>
							<Dialog.Close className="customize-dialog-close" aria-label="Close">
								<XIcon aria-hidden="true" />
							</Dialog.Close>
						</header>
						{children}
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}

/** Add, Create a skill: a name, a description and the instructions; nothing but the files is written. */
export function CreateSkillForm({
	api,
	projectId,
	onClose,
	onCreated,
	onPending,
}: {
	api: Pick<DesktopApi, 'createSkill'>
	projectId?: string
	onClose: () => void
	onCreated: (name: string) => void
	onPending?: (pending: boolean) => void
}) {
	const uid = useId()
	const [name, setName] = useState('')
	const [description, setDescription] = useState('')
	const [instructions, setInstructions] = useState('')
	const [scope, setScope] = useState<SkillScope>('user')
	const [exists, setExists] = useState(false)
	const [error, setError] = useState<string>()
	const [pending, setPendingState] = useState(false)
	const setPending = (value: boolean) => {
		setPendingState(value)
		onPending?.(value)
	}
	const folder = skillFolderName(name)
	const problem = createProblem({ name, description, instructions })
	const submit = async (replace: boolean) => {
		if (problem || pending || !api.createSkill) return
		setPending(true)
		setError(undefined)
		try {
			const answer = await api.createSkill(
				{
					name: folder,
					description: description.trim(),
					instructions,
					scope,
					...(replace ? { replace: true } : {}),
				},
				projectId,
			)
			if (!answer) setError('Update Namzu to make skills from here.')
			else if (answer.outcome === 'exists') {
				setExists(true)
				setError(`You already have a skill named "${folder}".`)
			} else if (answer.outcome === 'created') {
				notify(`Created ${folder}. ${answer.note ?? 'It loads in new conversations.'}`, {
					tone: 'success',
				})
				window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT))
				onCreated(folder)
			} else setError(answer.error ?? 'The skill could not be created.')
		} catch (failure) {
			setError(plainErrorText(failure, 'create the skill'))
		} finally {
			setPending(false)
		}
	}
	return (
		<form
			className="customize-form"
			onSubmit={(event) => {
				event.preventDefault()
				void submit(false)
			}}
		>
			<div className="customize-field">
				<label className="customize-field-label" htmlFor={`${uid}-name`}>
					Skill name
				</label>
				<input
					id={`${uid}-name`}
					data-autofocus
					className="customize-input"
					value={name}
					placeholder="Weekly status report"
					maxLength={120}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => {
						setName(event.target.value)
						setExists(false)
					}}
				/>
				{folder && name.trim() !== folder && (
					<span className="customize-hint">
						Saved as <code>{folder}</code>
					</span>
				)}
			</div>
			<div className="customize-field">
				<label className="customize-field-label" htmlFor={`${uid}-description`}>
					Description
				</label>
				<textarea
					id={`${uid}-description`}
					className="customize-input"
					rows={3}
					value={description}
					placeholder="Generate weekly status reports from recent work. Use when asked for updates or progress summaries."
					maxLength={DESCRIPTION_MAX + 200}
					onChange={(event) => setDescription(event.target.value)}
				/>
				<span className="customize-counter">
					{description.length}/{DESCRIPTION_MAX}
				</span>
				{problem === XML_DESCRIPTION_PROBLEM && <span className="customize-error">{problem}</span>}
			</div>
			<div className="customize-field">
				<label className="customize-field-label" htmlFor={`${uid}-instructions`}>
					Instructions
				</label>
				<textarea
					id={`${uid}-instructions`}
					className="customize-input customize-mono"
					rows={9}
					value={instructions}
					placeholder="Summarize my recent work in three sections: wins, blockers, and next steps. Keep the tone professional but not stiff…"
					spellCheck={false}
					onChange={(event) => setInstructions(event.target.value)}
				/>
				{startsWithFrontmatter(instructions) && (
					<span className="customize-hint">{FRONTMATTER_NOTE}</span>
				)}
			</div>
			<ScopePicker scope={scope} onScope={setScope} projectReady={Boolean(projectId)} />
			{error && (
				<p className="customize-error" role="alert">
					{error}
				</p>
			)}
			<div className="dialog-actions customize-dialog-actions">
				{problem && problem !== XML_DESCRIPTION_PROBLEM && (
					<span className="customize-hint customize-dialog-hint">{problem}</span>
				)}
				<Button type="button" variant="outline" disabled={pending} onClick={onClose}>
					Cancel
				</Button>
				{exists && (
					<Button
						type="button"
						variant="outline"
						disabled={pending}
						onClick={() => void submit(true)}
					>
						Replace
					</Button>
				)}
				<Button
					type="submit"
					className="customize-primary"
					disabled={Boolean(problem) || pending || exists}
				>
					{pending ? 'Creating…' : 'Create'}
				</Button>
			</div>
		</form>
	)
}

export function CreateSkillDialog({
	returnFocus,
	onClose,
	...form
}: Parameters<typeof CreateSkillForm>[0] & { returnFocus: () => HTMLElement | null }) {
	const [busy, setBusy] = useState(false)
	return (
		<Overlay
			title="Create a skill"
			onClose={onClose}
			returnFocus={returnFocus}
			size="wide"
			locked={busy}
		>
			<CreateSkillForm onClose={onClose} {...form} onPending={setBusy} />
		</Overlay>
	)
}

const AUTH: readonly { id: ConnectorAuth; label: string }[] = [
	{ id: 'none', label: 'No sign-in' },
	{ id: 'sign-in', label: 'Sign in when asked' },
	{ id: 'header', label: 'Header' },
]

/** Add, Add custom connector: an address saved as a remote tool server that waits for approval. */
export function AddConnectorForm({
	save,
	onClose,
	onSaved,
	onPending,
}: {
	/** Saves through `namzu/mcp/save-user-server`; true once the engine took it. */
	save: (change: ReturnType<typeof connectorChange>) => Promise<boolean>
	onClose: () => void
	onSaved: (name: string) => void
	onPending?: (pending: boolean) => void
}) {
	const uid = useId()
	const [draft, setDraft] = useState(emptyConnector)
	const [error, setError] = useState<string>()
	const [pending, setPendingState] = useState(false)
	const setPending = (value: boolean) => {
		setPendingState(value)
		onPending?.(value)
	}
	// A field shows its own problem once the person has been in it; until then the hint says what is missing.
	const [touched, setTouched] = useState<ReadonlySet<keyof ConnectorProblems>>(() => new Set())
	const touch = (field: keyof ConnectorProblems) =>
		setTouched((all) => (all.has(field) ? all : new Set(all).add(field)))
	const problems = connectorProblems(draft)
	const problem = connectorProblem(draft)
	const shown = (field: keyof ConnectorProblems): string | undefined =>
		touched.has(field) ? problems[field] : undefined
	const anyShown = shown('name') ?? shown('url') ?? shown('header')
	const submit = async () => {
		if (problem || pending) return
		setPending(true)
		setError(undefined)
		try {
			const change = connectorChange(draft)
			if (await save(change)) onSaved(change.name)
			else setError('The connector could not be saved.')
		} catch (failure) {
			setError(plainErrorText(failure, 'save the connector'))
		} finally {
			setPending(false)
		}
	}
	return (
		<form
			className="customize-form"
			onSubmit={(event) => {
				event.preventDefault()
				void submit()
			}}
		>
			<p className="dialog-body">{CONNECTOR_INTRO}</p>
			<div className="customize-field">
				<label className="customize-field-label" htmlFor={`${uid}-cname`}>
					Name
				</label>
				<input
					id={`${uid}-cname`}
					data-autofocus
					className="customize-input"
					value={draft.name}
					placeholder="example-tools"
					autoComplete="off"
					spellCheck={false}
					aria-invalid={Boolean(shown('name')) || undefined}
					aria-describedby={`${uid}-cname-help${shown('name') ? ` ${uid}-cname-error` : ''}`}
					onBlur={() => touch('name')}
					onChange={(event) => setDraft({ ...draft, name: event.target.value })}
				/>
				<span className="customize-hint" id={`${uid}-cname-help`}>
					{CONNECTOR_NAME_HELP}
				</span>
				{shown('name') && (
					<span className="customize-error" id={`${uid}-cname-error`}>
						{shown('name')}
					</span>
				)}
			</div>
			<div className="customize-field">
				<label className="customize-field-label" htmlFor={`${uid}-curl`}>
					MCP server URL
				</label>
				<input
					id={`${uid}-curl`}
					className="customize-input"
					value={draft.url}
					placeholder="https://mcp.example.com/mcp"
					autoComplete="off"
					spellCheck={false}
					inputMode="url"
					aria-invalid={Boolean(shown('url')) || undefined}
					aria-describedby={`${uid}-curl-help${shown('url') ? ` ${uid}-curl-error` : ''}`}
					onBlur={() => touch('url')}
					onChange={(event) => setDraft({ ...draft, url: event.target.value })}
				/>
				<span className="customize-hint" id={`${uid}-curl-help`}>
					{CONNECTOR_URL_HELP}
				</span>
				{shown('url') && (
					<span className="customize-error" id={`${uid}-curl-error`}>
						{shown('url')}
					</span>
				)}
			</div>
			<fieldset className="customize-fieldset">
				<legend className="customize-field-label">Authentication</legend>
				<div className="customize-segments">
					{AUTH.map((item) => (
						<label key={item.id} className="customize-segment">
							<input
								type="radio"
								name="connector-auth"
								checked={draft.auth === item.id}
								onChange={() => setDraft({ ...draft, auth: item.id })}
							/>
							<span>{item.label}</span>
						</label>
					))}
				</div>
				{draft.auth === 'header' && (
					<div className="customize-header-pair">
						<input
							className="customize-input"
							aria-label="Header name"
							aria-invalid={Boolean(shown('header')) || undefined}
							aria-describedby={shown('header') ? `${uid}-cheader-error` : undefined}
							onBlur={() => touch('header')}
							placeholder="Authorization"
							value={draft.header.name}
							autoComplete="off"
							spellCheck={false}
							onChange={(event) =>
								setDraft({ ...draft, header: { ...draft.header, name: event.target.value } })
							}
						/>
						<input
							className="customize-input"
							aria-label="Header value"
							aria-invalid={Boolean(shown('header')) || undefined}
							aria-describedby={shown('header') ? `${uid}-cheader-error` : undefined}
							onBlur={() => touch('header')}
							placeholder="Bearer ${EXAMPLE_TOKEN}"
							value={draft.header.value}
							autoComplete="off"
							spellCheck={false}
							onChange={(event) =>
								setDraft({ ...draft, header: { ...draft.header, value: event.target.value } })
							}
						/>
					</div>
				)}
				{shown('header') && (
					<span className="customize-error" id={`${uid}-cheader-error`}>
						{shown('header')}
					</span>
				)}
			</fieldset>
			<p className="dialog-body">{CONNECTOR_NOTICE}</p>
			{error && (
				<p className="customize-error" role="alert">
					{error}
				</p>
			)}
			<div className="dialog-actions customize-dialog-actions">
				{problem && !anyShown && (
					<span className="customize-hint customize-dialog-hint">{problem}</span>
				)}
				<Button type="button" variant="outline" disabled={pending} onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" className="customize-primary" disabled={Boolean(problem) || pending}>
					{pending ? 'Saving…' : 'Save'}
				</Button>
			</div>
		</form>
	)
}

export function AddConnectorDialog({
	returnFocus,
	onClose,
	...form
}: Parameters<typeof AddConnectorForm>[0] & { returnFocus: () => HTMLElement | null }) {
	const [busy, setBusy] = useState(false)
	return (
		<Overlay title="Add custom connector" onClose={onClose} returnFocus={returnFocus} locked={busy}>
			<AddConnectorForm onClose={onClose} {...form} onPending={setBusy} />
		</Overlay>
	)
}
