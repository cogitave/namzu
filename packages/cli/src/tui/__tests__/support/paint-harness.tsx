/**
 * A small program for the pseudo-terminal test of the default screen's writer
 * (`../../paint/live-paint.pty.test.ts`): Ink on the real terminal through `createLivePaint`, driven
 * by lines typed to it, with no model and no network.
 *
 *   row <text>   prints a row once, above the live region
 *   live <text>  sets the live line
 *   crash        throws from a timer, so the process ends without unmounting
 *   quit         unmounts and exits
 */

import { Box, Static, Text, render, useWindowSize } from 'ink'
import { useEffect, useState } from 'react'

import { createLivePaint } from '../../paint/live-paint.js'

const out = process.stdout
const paint = createLivePaint(out)

let setRows: ((rows: string[]) => void) | undefined
let setLive: ((text: string) => void) | undefined

function Screen() {
	const [rows, setRowsState] = useState<string[]>([])
	const [live, setLiveState] = useState('ready')
	const { columns } = useWindowSize()
	useEffect(() => {
		setRows = setRowsState
		setLive = setLiveState
	}, [])
	return (
		<Box flexDirection="column">
			<Static items={rows}>{(row, index) => <Text key={`${index}`}>{row}</Text>}</Static>
			<Text>{'-'.repeat(Math.max(1, columns - 1))}</Text>
			<Text>{`live: ${live}`}</Text>
			<Text>{`cols ${columns}`}</Text>
		</Box>
	)
}

const printed: string[] = []
let typed = ''
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
	typed += chunk
	for (;;) {
		const end = typed.search(/[\r\n]/)
		if (end < 0) return
		const line = typed.slice(0, end)
		typed = typed.slice(end + 1)
		if (line.startsWith('row ')) {
			printed.push(line.slice(4))
			setRows?.([...printed])
		} else if (line.startsWith('live ')) setLive?.(line.slice(5))
		else if (line === 'crash')
			setTimeout(() => {
				throw new Error('crash on purpose')
			}, 0)
		else if (line === 'quit') {
			instance.unmount()
			void instance.waitUntilExit().then(() => {
				paint.dispose()
				process.exit(0)
			})
		}
	}
})

// Raw mode and the reader are in place before the first frame, so the screen showing the first frame
// means typed lines are no longer echoed by the line discipline under the region.
const instance = render(<Screen />, {
	stdout: paint.stream,
	stdin: process.stdin,
	interactive: true,
	patchConsole: false,
	exitOnCtrlC: false,
})
