import {
	AppWindow,
	ChevronRight,
	Copy,
	Download,
	ExternalLink,
	FileText,
	FolderOpen,
	TriangleAlert,
} from 'lucide-react'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ThreadState } from '../shared/projection.js'
import type { DesktopApi, SessionOutputDetail } from '../shared/protocol.js'
import { copyPlainText } from './copy-button.js'
import {
	type OutputCard,
	type OutputGroupView,
	cardAccessibleName,
	outputGroupView,
	sharedFilesOf,
	turnOutputCards,
} from './output-card-model.js'
import type { OutputFile } from './outputs-model.js'
import { plainErrorText } from './plain-error.js'
import type { TurnChanges } from './turn-changes.js'
import './output-card.css'

/** What the cards need from the app: the host calls, the conversation, and where a card leads. */
export interface OutputCardsContextValue {
	api: Pick<
		DesktopApi,
		'readSessionOutput' | 'openSessionOutput' | 'describeSessionOutputs' | 'saveSessionOutput'
	>
	sessionId: string
	/** The conversation's folder: a handed-over file outside it opens in its own program, not beside the conversation. */
	projectPath?: string
	/** Result files found by the host that no receipt names. */
	made: readonly OutputFile[]
	/** Shows the output beside the conversation. */
	onOpen: (path: string) => void
	onNotice: (text: string) => void
}
export const OutputCardsContext = createContext<OutputCardsContextValue | undefined>(undefined)

/** The size of the finished cards, for the tooltip; asked again when the turn settles. */
function useDetails(
	ctx: OutputCardsContextValue | undefined,
	paths: readonly string[],
	settled: boolean,
): ReadonlyMap<string, SessionOutputDetail> {
	const [details, setDetails] = useState<ReadonlyMap<string, SessionOutputDetail>>(new Map())
	const key = paths.join('\n')
	// biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the path list.
	useEffect(() => {
		const ask = ctx?.api.describeSessionOutputs
		if (!ask || !settled || paths.length === 0) return
		let current = true
		ask(ctx.sessionId, [...paths]).then(
			(rows) => current && setDetails(new Map(rows.map((row) => [row.path, row]))),
			() => undefined,
		)
		return () => {
			current = false
		}
	}, [ctx?.api, ctx?.sessionId, key, settled])
	return details
}

function CardActions({ card, ctx }: { card: OutputCard; ctx: OutputCardsContextValue }) {
	const [copied, setCopied] = useState(false)
	const timer = useRef<number | undefined>(undefined)
	useEffect(() => () => window.clearTimeout(timer.current), [])
	if (card.state !== 'done') return null
	const fail = (what: string) => (failure: unknown) => ctx.onNotice(plainErrorText(failure, what))
	const open = (target: 'browser' | 'system' | 'file-manager') =>
		void (
			ctx.api.openSessionOutput
				? ctx.api.openSessionOutput(ctx.sessionId, card.path, target)
				: Promise.reject(new Error('Opening is not available.'))
		).catch(
			fail(
				target === 'browser'
					? 'open the page'
					: target === 'file-manager'
						? 'show the file in its folder'
						: 'open the file',
			),
		)
	const copy = () =>
		void (async () => {
			const read = ctx.api.readSessionOutput
			if (!read) throw new Error('Copying is not available.')
			const content = await read(ctx.sessionId, card.path)
			if (content.text === undefined) throw new Error('This file is not text.')
			await copyPlainText(content.text)
			setCopied(true)
			window.clearTimeout(timer.current)
			timer.current = window.setTimeout(() => setCopied(false), 1500)
		})().catch(fail('copy the file'))
	const save = () =>
		void (
			ctx.api.saveSessionOutput
				? ctx.api.saveSessionOutput(ctx.sessionId, card.path)
				: Promise.reject(new Error('Saving is not available.'))
		).catch(fail('save a copy'))
	return (
		<span className="output-card-actions">
			{card.canOpenInBrowser && (
				<button
					type="button"
					className="output-card-action"
					title="Open in browser"
					aria-label={`Open ${card.name} in the browser`}
					onClick={() => open('browser')}
				>
					<AppWindow aria-hidden />
				</button>
			)}
			{card.canOpenWithSystem && (
				<button
					type="button"
					className="output-card-action"
					title="Open with the app for this kind of file"
					aria-label={`Open ${card.name} with the app for this kind of file`}
					onClick={() => open('system')}
				>
					<ExternalLink aria-hidden />
				</button>
			)}
			{card.canShowInFolder && (
				<button
					type="button"
					className="output-card-action"
					title="Show in folder"
					aria-label={`Show ${card.name} in its folder`}
					onClick={() => open('file-manager')}
				>
					<FolderOpen aria-hidden />
				</button>
			)}
			{card.canCopy && (
				<button
					type="button"
					className="output-card-action"
					title={copied ? 'Copied' : 'Copy the text'}
					aria-label={copied ? 'Copied' : `Copy the text of ${card.name}`}
					onClick={copy}
				>
					<Copy aria-hidden />
				</button>
			)}
			{card.canSave && (
				<button
					type="button"
					className="output-card-action"
					title="Save a copy…"
					aria-label={`Save a copy of ${card.name}`}
					onClick={save}
				>
					<Download aria-hidden />
				</button>
			)}
		</span>
	)
}

const slashes = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** A handed-over file that sits outside the conversation's folder, which the Files pane cannot show. */
function outsideFolder(card: OutputCard, projectPath: string | undefined): boolean {
	if (!card.shared || !projectPath) return false
	const root = slashes(projectPath)
	return !slashes(card.path).startsWith(`${root}/`)
}

/** One compact row: a document icon, the title, one state word, a chevron. */
export function OutputCardView({ card, ctx }: { card: OutputCard; ctx: OutputCardsContextValue }) {
	const [opened, setOpened] = useState(false)
	const outside = outsideFolder(card, ctx.projectPath)
	const beside = card.canOpen && !outside
	const press = () => {
		setOpened(true)
		if (!outside) return ctx.onOpen(card.path)
		const target = card.canOpenWithSystem ? 'system' : 'file-manager'
		void (
			ctx.api.openSessionOutput
				? ctx.api.openSessionOutput(ctx.sessionId, card.path, target)
				: Promise.reject(new Error('Opening is not available.'))
		).catch((failure: unknown) => ctx.onNotice(plainErrorText(failure, 'open the file')))
	}
	const word = opened && card.state === 'done' ? 'Opened' : card.stateWord
	const failed = card.state === 'failed'
	const body = (
		<>
			<span className="output-card-icon" aria-hidden="true">
				{failed ? <TriangleAlert /> : <FileText />}
			</span>
			<span className="output-card-name">{card.name}</span>
			<span className="output-card-state">{word}</span>
			{beside && <ChevronRight className="output-card-chevron" aria-hidden />}
		</>
	)
	const title = card.reason ? `${card.kindLine}. ${card.reason}` : card.kindLine
	return (
		<div className="output-card" data-output-card={card.path} data-state={card.state} title={title}>
			{card.canOpen ? (
				<button
					type="button"
					className="output-card-main"
					aria-label={
						outside
							? `${card.name}, ${card.kindLine}. ${card.canOpenWithSystem ? 'Open with the app for this kind of file.' : 'Show in its folder.'}`
							: cardAccessibleName(card)
					}
					onClick={press}
				>
					{body}
				</button>
			) : (
				<div className="output-card-main" role="note" aria-label={cardAccessibleName(card)}>
					{body}
				</div>
			)}
			{failed && card.reason && <span className="output-card-reason">{card.reason}</span>}
			{card.caption && <span className="output-card-caption">{card.caption}</span>}
			<CardActions card={card} ctx={ctx} />
			{card.state === 'writing' && <span className="output-card-progress" aria-hidden="true" />}
		</div>
	)
}

export function OutputGroup({
	view,
	ctx,
	onExpand,
}: { view: OutputGroupView; ctx: OutputCardsContextValue; onExpand: () => void }) {
	return (
		<section className="output-group" aria-label={view.label} data-output-group>
			{view.caption && <p className="output-group-caption">Made in this reply</p>}
			{view.rows.map((card) => (
				<OutputCardView key={card.key} card={card} ctx={ctx} />
			))}
			{view.hidden > 0 && (
				<button type="button" className="output-group-more" onClick={onExpand}>
					Show {view.hidden} more
				</button>
			)}
		</section>
	)
}

/**
 * The group of cards under one reply. It reads the same receipts and made-file list the Outputs
 * pane does, and draws nothing when the reply made nothing.
 */
export function TurnOutputs({
	thread,
	turn,
	changes,
}: {
	thread: ThreadState
	turn: number
	changes: TurnChanges | undefined
}) {
	const ctx = useContext(OutputCardsContext)
	const [expanded, setExpanded] = useState(false)
	const settled = !(thread.running && thread.turn === turn)
	const paths = useMemo(
		() => [
			...(changes?.files.map((file) => file.path) ?? []),
			...(ctx?.made.filter((file) => file.turn === turn).map((file) => file.path) ?? []),
			...sharedFilesOf({ timeline: thread.timeline, tools: thread.tools }, turn).map(
				(file) => file.path,
			),
		],
		[changes, ctx?.made, turn, thread.timeline, thread.tools],
	)
	const details = useDetails(ctx, paths, settled)
	const { timeline, tools, turns, undo, running, activeToolIds } = thread
	const cards = useMemo(
		() =>
			turnOutputCards(
				{ timeline, tools, turns, undo, running, turn: thread.turn, activeToolIds },
				turn,
				changes,
				ctx?.made ?? [],
				details,
			),
		[
			timeline,
			tools,
			turns,
			undo,
			running,
			activeToolIds,
			thread.turn,
			turn,
			changes,
			ctx?.made,
			details,
		],
	)
	if (!ctx || cards.length === 0) return null
	return (
		<OutputGroup
			view={outputGroupView(cards, expanded)}
			ctx={ctx}
			onExpand={() => setExpanded(true)}
		/>
	)
}
