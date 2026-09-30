import type { AcpSessionUpdate } from '@namzu/sdk'
import { MultiFileDiff } from '@pierre/diffs/react'
import { Columns2Icon, Rows3Icon, TextWrapIcon } from 'lucide-react'
import { useState } from 'react'
import { DIFF_VIEW_UNSAFE_CSS } from './diff-theme.js'
import { Button } from './ui/button.js'

type Tool = Extract<AcpSessionUpdate, { kind: 'tool_call' }>
/** The exact before/after from completed calls; no inferred repository or pending changes. */
export function ChangesPanel({ tools, dark }: { tools: Tool[]; dark: boolean }) {
	const [split, setSplit] = useState(false)
	const [wrap, setWrap] = useState(false)
	const changes = tools.filter((tool) => tool.status === 'completed' && tool.view.kind === 'diff')
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4">
				<span className="truncate text-xs text-muted-foreground">
					{changes.length
						? `${changes.length} file ${changes.length === 1 ? 'change' : 'changes'}`
						: 'This conversation'}
				</span>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost-muted"
						size="icon-xs"
						aria-label={split ? 'Use unified diff' : 'Use split diff'}
						aria-pressed={split}
						onClick={() => setSplit(!split)}
					>
						{split ? <Columns2Icon /> : <Rows3Icon />}
					</Button>
					<Button
						variant="ghost-muted"
						size="icon-xs"
						aria-label="Wrap diff lines"
						aria-pressed={wrap}
						onClick={() => setWrap(!wrap)}
					>
						<TextWrapIcon />
					</Button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{changes.length === 0 && (
					<p className="px-4 py-6 text-sm text-muted-foreground">
						File changes from completed actions will appear here.
					</p>
				)}
				{changes.map(
					(tool) =>
						tool.view.kind === 'diff' && (
							<MultiFileDiff
								key={tool.toolCallId}
								className="diff-code-view"
								oldFile={{
									name: tool.view.path || tool.view.label || 'File',
									contents: tool.view.before || '',
								}}
								newFile={{
									name: tool.view.path || tool.view.label || 'File',
									contents: tool.view.after || '',
								}}
								options={{
									theme: { light: 'pierre-light', dark: 'pierre-dark' },
									themeType: dark ? 'dark' : 'light',
									preferredHighlighter: 'shiki-wasm',
									diffStyle: split ? 'split' : 'unified',
									diffIndicators: 'bars',
									overflow: wrap ? 'wrap' : 'scroll',
									hunkSeparators: 'line-info',
									unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
								}}
							/>
						),
				)}
			</div>
		</div>
	)
}
