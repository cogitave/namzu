import {
	AppWindow,
	Code,
	Copy,
	Download,
	ExternalLink,
	File,
	FileText,
	Image,
	Presentation,
	Table2,
	TriangleAlert,
} from 'lucide-react'
import {
	type ComponentType,
	createContext,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import type { OutputCardKind } from '../shared/output-files.js'
import type { ThreadState } from '../shared/projection.js'
import type { DesktopApi, SessionOutputDetail } from '../shared/protocol.js'
import { copyPlainText } from './copy-button.js'
import {
	type OutputCard,
	type OutputGroupView,
	cardAccessibleName,
	outputGroupView,
	turnOutputCards,
} from './output-card-model.js'
import { OUTPUT_FRAME_SANDBOX, outputFrameDocument } from './output-frame.js'
import type { OutputFile } from './outputs-model.js'
import { useSessionOutput } from './outputs-panel.js'
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
	/** Result files found by the host that no receipt names. */
	made: readonly OutputFile[]
	/** Shows the output beside the conversation. */
	onOpen: (path: string) => void
	onNotice: (text: string) => void
}
export const OutputCardsContext = createContext<OutputCardsContextValue | undefined>(undefined)

const GLYPHS: Record<OutputCardKind, ComponentType<{ 'aria-hidden'?: boolean }>> = {
	page: AppWindow,
	document: FileText,
	image: Image,
	spreadsheet: Table2,
	presentation: Presentation,
	code: Code,
	file: File,
}

/** Size and a first line for the finished cards; asked again when the turn settles. */
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

function Thumb({
	card,
	large,
	ctx,
}: { card: OutputCard; large: boolean; ctx: OutputCardsContextValue }) {
	const Glyph = GLYPHS[card.kind]
	const wantsImage = card.kind === 'image' && card.state === 'done'
	const wantsPage = card.kind === 'page' && card.state === 'done' && large
	const load = useSessionOutput(ctx.api, ctx.sessionId, wantsImage || wantsPage ? card.path : '', 0)
	if (wantsImage && load.status === 'ready' && load.content.kind === 'image' && load.content.image)
		return (
			<span className="output-card-thumb" data-thumb="image">
				<img src={load.content.image} alt="" />
			</span>
		)
	if (wantsPage && load.status === 'ready' && load.content.text !== undefined)
		return (
			<span
				className="output-card-thumb output-card-thumb-page"
				data-thumb="page"
				aria-hidden="true"
			>
				<iframe
					title="Preview"
					tabIndex={-1}
					sandbox={OUTPUT_FRAME_SANDBOX}
					referrerPolicy="no-referrer"
					srcDoc={outputFrameDocument(load.content.text)}
				/>
			</span>
		)
	return (
		<span
			className="output-card-tile"
			data-kind={card.kind}
			data-sheet={large && card.kind === 'document' ? '' : undefined}
		>
			{card.state === 'failed' ? <TriangleAlert aria-hidden /> : <Glyph aria-hidden />}
		</span>
	)
}

function CardActions({ card, ctx }: { card: OutputCard; ctx: OutputCardsContextValue }) {
	const [copied, setCopied] = useState(false)
	const timer = useRef<number | undefined>(undefined)
	useEffect(() => () => window.clearTimeout(timer.current), [])
	if (card.state !== 'done') return null
	const fail = (what: string) => (failure: unknown) => ctx.onNotice(plainErrorText(failure, what))
	const open = (target: 'browser' | 'system') =>
		void (
			ctx.api.openSessionOutput
				? ctx.api.openSessionOutput(ctx.sessionId, card.path, target)
				: Promise.reject(new Error('Opening is not available.'))
		).catch(fail(target === 'browser' ? 'open the page' : 'open the file'))
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

export function OutputCardView({
	card,
	large,
	ctx,
}: { card: OutputCard; large: boolean; ctx: OutputCardsContextValue }) {
	const body = (
		<>
			<Thumb card={card} large={large} ctx={ctx} />
			<span className="output-card-text">
				<span className="output-card-name">{card.name}</span>
				<span className="output-card-kind">{card.kindLine}</span>
				{card.reason && <span className="output-card-reason">{card.reason}</span>}
				{card.preview && <span className="output-card-preview">{card.preview}</span>}
			</span>
		</>
	)
	return (
		<div
			className="output-card"
			data-output-card={card.path}
			data-state={card.state}
			data-large={large ? '' : undefined}
			title={card.path}
		>
			{card.canOpen ? (
				<button
					type="button"
					className="output-card-main"
					aria-label={cardAccessibleName(card)}
					onClick={() => ctx.onOpen(card.path)}
				>
					{body}
				</button>
			) : (
				<div className="output-card-main" role="note" aria-label={cardAccessibleName(card)}>
					{body}
				</div>
			)}
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
			<p className="output-group-caption">Made in this reply</p>
			{view.pictures.length > 0 && (
				<div className="output-group-pictures">
					{view.pictures.map((card) => (
						<OutputCardView key={card.key} card={card} large={false} ctx={ctx} />
					))}
				</div>
			)}
			{view.rows.map((card) => (
				<OutputCardView key={card.key} card={card} large={view.large} ctx={ctx} />
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
		],
		[changes, ctx?.made, turn],
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
