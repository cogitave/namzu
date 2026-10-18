import { useContext, useId, useState } from 'react'
import { BackgroundWorkContext } from './activity-actions.js'
import { type ShellCellData, shellCellRows } from './shell-cell.js'
import { OutputText } from './tool-output-view.js'
import { Button } from './ui/button.js'
import './shell-cell.css'

/** A finished command's output under its row: first lines, errors in the error colour, how it ended once. */
export function ShellCell({ cell }: { cell: ShellCellData }) {
	const [expanded, setExpanded] = useState(false)
	const id = useId()
	const openBackground = useContext(BackgroundWorkContext)
	const rows = shellCellRows(cell, expanded)
	const canFold = rows.hidden > 0 || expanded
	return (
		<div className="shell-cell" data-shell-cell data-failed={cell.failed || undefined}>
			{rows.lines.length > 0 && (
				<pre className="shell-cell-output" id={id}>
					{rows.lines.map((line, index) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reordered
							key={index}
							className={`shell-cell-line shell-cell-${line.tone}`}
						>
							{line.tone === 'gap' ? line.text : <OutputText text={line.text} />}
							{'\n'}
						</span>
					))}
				</pre>
			)}
			<p className="shell-cell-foot">
				{rows.note && (
					<span className={`shell-cell-note shell-cell-${rows.noteTone ?? 'dim'}`}>
						{rows.note}
					</span>
				)}
				{canFold && (
					<button
						type="button"
						className="shell-cell-more"
						aria-expanded={expanded}
						aria-controls={id}
						onClick={() => setExpanded(!expanded)}
					>
						{expanded
							? 'Show less'
							: `+${rows.hidden.toLocaleString('en')} ${rows.hidden === 1 ? 'line' : 'lines'}`}
					</button>
				)}
				{cell.background && openBackground && (
					<Button variant="ghost-muted" size="xs" onClick={openBackground}>
						See it
					</Button>
				)}
			</p>
		</div>
	)
}
