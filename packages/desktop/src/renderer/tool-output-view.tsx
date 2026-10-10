import { useId, useState } from 'react'
import './tool-output.css'
import {
	COLLAPSED_HEAD_LINES,
	COLLAPSED_TAIL_LINES,
	type OutputSpan,
	outputSpans,
	plainTerminalText,
} from './tool-output.js'
import type { StreamText, ToolBody } from './tool-transcript-presentation.js'

/** Colour and weight as the stylesheet names them; a colour the program chose exactly rides inline. */
function spanClass(span: OutputSpan): string | undefined {
	const names = [
		span.fg,
		span.bg,
		span.bold ? 'ansi-bold' : '',
		span.dim ? 'ansi-dim' : '',
		span.italic ? 'ansi-italic' : '',
		span.underline ? 'ansi-underline' : '',
	].filter(Boolean)
	return names.length ? names.join(' ') : undefined
}

/** Terminal text with its colours drawn, as text nodes: nothing here is ever parsed as markup. */
export function OutputText({ text }: { text: string }) {
	const spans = outputSpans(text)
	return (
		<>
			{spans.map((span, index) => {
				const className = spanClass(span)
				const style =
					span.fgRgb || span.bgRgb
						? {
								...(span.fgRgb ? { color: `rgb(${span.fgRgb})` } : {}),
								...(span.bgRgb ? { backgroundColor: `rgb(${span.bgRgb})` } : {}),
							}
						: undefined
				return className || style ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and never reordered
					<span key={index} className={className} style={style}>
						{span.text}
					</span>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and never reordered
					<span key={index}>{span.text}</span>
				)
			})}
		</>
	)
}

type Part = { kind: 'text'; text: string } | { kind: 'gap'; lines: number }

function lines(text: string): string[] {
	return text === '' ? [] : text.split('\n')
}

/**
 * What a stream shows before "Show more": its first lines and its last lines, with the number
 * left out between. What it shows after: everything the SDK kept, with the gap it left.
 */
export function streamParts(stream: StreamText): {
	collapsed: Part[]
	expanded: Part[]
	expandable: boolean
	hidden: number
} {
	const head = lines(stream.head)
	const tail = lines(stream.tail ?? '')
	const expanded: Part[] = [{ kind: 'text', text: stream.head }]
	if (stream.omitted > 0) expanded.push({ kind: 'gap', lines: stream.omitted })
	if (stream.tail) expanded.push({ kind: 'text', text: stream.tail })
	const kept = head.length + tail.length
	if (stream.omitted === 0 && kept <= COLLAPSED_HEAD_LINES + COLLAPSED_TAIL_LINES + 1)
		return { collapsed: expanded, expanded, expandable: false, hidden: 0 }
	const first = head.slice(0, COLLAPSED_HEAD_LINES)
	const last = (tail.length ? tail : head).slice(-COLLAPSED_TAIL_LINES)
	const hidden = Math.max(1, stream.total - first.length - last.length)
	return {
		collapsed: [
			{ kind: 'text', text: first.join('\n') },
			{ kind: 'gap', lines: hidden },
			{ kind: 'text', text: last.join('\n') },
		],
		expanded,
		expandable: true,
		hidden,
	}
}

function gapLabel(lines: number): string {
	return `${lines.toLocaleString('en')} ${lines === 1 ? 'line' : 'lines'} not shown`
}

function Parts({ parts }: { parts: Part[] }) {
	return (
		<>
			{parts.map((part, index) =>
				part.kind === 'text' ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reordered
					<OutputText key={index} text={`${part.text}${index < parts.length - 1 ? '\n' : ''}`} />
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reordered
					<span key={index} className="tool-output-gap">
						{`… ${gapLabel(part.lines)} …\n`}
					</span>
				),
			)}
		</>
	)
}

/** One block of output, folded to its first and last lines until the person asks for the rest. */
export function OutputBlock({ stream, label }: { stream: StreamText; label?: string }) {
	const [open, setOpen] = useState(false)
	const id = useId()
	const parts = streamParts(stream)
	const shown = open ? parts.expanded : parts.collapsed
	return (
		<div className="tool-output-block">
			{label && <p className="tool-output-label">{label}</p>}
			<pre className="tool-output" id={id} data-expanded={open ? '' : undefined}>
				<Parts parts={shown} />
			</pre>
			{parts.expandable && (
				<button
					type="button"
					className="tool-output-more"
					aria-expanded={open}
					aria-controls={id}
					onClick={() => setOpen(!open)}
				>
					{open ? 'Show less' : 'Show more'}
				</button>
			)}
		</div>
	)
}

/** Plain output text, folded the same way. */
export function TextBlock({ text }: { text: string }) {
	const all = lines(text.endsWith('\n') ? text.slice(0, -1) : text)
	const stream: StreamText =
		all.length <= 300
			? { head: all.join('\n'), omitted: 0, total: all.length }
			: {
					head: all.slice(0, 200).join('\n'),
					tail: all.slice(-60).join('\n'),
					omitted: all.length - 260,
					total: all.length,
				}
	return <OutputBlock stream={stream} />
}

/** What a row opens to when the tool reported typed facts. */
export function ToolBodyView({ body }: { body: ToolBody }) {
	if (body.kind === 'notice')
		return (
			<div className="tool-content">
				<p className="tool-note">{body.text}</p>
			</div>
		)
	if (body.kind === 'text')
		return (
			<div className="tool-content">
				<TextBlock text={body.text} />
			</div>
		)
	return (
		<div className="tool-content">
			{body.command && <pre className="tool-command">{body.command}</pre>}
			{body.stdout && <OutputBlock stream={body.stdout} />}
			{body.stderr && (
				<OutputBlock stream={body.stderr} {...(body.stdout ? { label: 'Errors' } : {})} />
			)}
		</div>
	)
}

/** The text of an output as one plain string, for a tooltip or a screen reader. */
export function plainOutput(text: string): string {
	return plainTerminalText(text)
}
