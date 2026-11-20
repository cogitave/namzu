import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
	EARLIER_NOT_SHOWN,
	type TailResult,
	type TailView,
	followsEnd,
	startTailPoll,
	tailView,
} from './background-tasks-model.js'

const FALLBACK: Record<'loading' | 'unavailable' | 'too-large' | 'empty', string> = {
	loading: 'Loading output…',
	unavailable: 'Output unavailable',
	'too-large': 'Output too large to show here',
	empty: 'No output yet',
}

/**
 * The live end of a task's output under its row: "$ command", then the last lines it printed. It reads
 * while it is mounted and the task runs, follows the end unless the person scrolled up, and says in
 * plain words when there is nothing to show.
 */
export function TaskOutput({
	command,
	running,
	read,
}: {
	command: string
	running: boolean
	read: () => Promise<TailResult | undefined>
}) {
	const [result, setResult] = useState<TailResult | 'error' | undefined>()
	const runningRef = useRef(running)
	runningRef.current = running
	const readRef = useRef(read)
	readRef.current = read
	const box = useRef<HTMLPreElement>(null)
	const follow = useRef(true)

	useEffect(() => {
		return startTailPoll({
			read: async () => (await readRef.current()) ?? { output: '' },
			onResult: setResult,
			running: () => runningRef.current,
		})
	}, [])
	// A task that ends while open is read once more, so its last lines are not missed.
	const ended = useRef(running)
	useEffect(() => {
		if (ended.current && !running) {
			void readRef
				.current()
				.then((last) => setResult(last ?? { output: '' }))
				.catch(() => undefined)
		}
		ended.current = running
	}, [running])

	const view: TailView = tailView(command, result)
	const text = view.kind === 'text' ? view.text : ''
	// biome-ignore lint/correctness/useExhaustiveDependencies: the text is what moves the end
	useLayoutEffect(() => {
		const node = box.current
		if (node && follow.current) node.scrollTop = node.scrollHeight
	}, [text, view.kind])

	return (
		<pre
			ref={box}
			className="task-output"
			// A scrollable region is reachable by keyboard and named for what it holds.
			// biome-ignore lint/a11y/noNoninteractiveTabindex: scrolling the output needs the keyboard
			tabIndex={0}
			aria-label={`Output of ${command}`}
			data-testid="task-output"
			onScroll={(event) => {
				const node = event.currentTarget
				follow.current = followsEnd(node.scrollHeight, node.scrollTop, node.clientHeight)
			}}
		>
			{'command' in view ? (
				<span className="task-output-command">{`$ ${view.command}\n`}</span>
			) : null}
			{view.kind === 'text' ? (
				<>
					{view.earlier && <span className="task-output-note">{`${EARLIER_NOT_SHOWN}\n`}</span>}
					{view.text}
				</>
			) : view.kind === 'empty' ? (
				<span className="task-output-note">{FALLBACK.empty}</span>
			) : (
				<span className="task-output-note">{FALLBACK[view.kind]}</span>
			)}
		</pre>
	)
}
