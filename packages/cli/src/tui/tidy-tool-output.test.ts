import { describe, expect, it } from 'vitest'

import { looksBinary, tidyCommandOutput, tidyTerminalOutput, unknownToolNotice } from './tidy-tool-output.js'

describe('command output in the transcript', () => {
	it('drops the credential note and the exit trailer, and names the failure plainly', () => {
		const tidy = tidyTerminalOutput(
			"hi\nls: cannot access '/x': No such file\nNOTE: 1 credential-shaped environment variable(s) were withheld from this command and are unset rather than empty: OPENAI_API_KEY. A host that means this command to have one passes it explicitly.\nError: Command exited with code 2",
		)
		expect(tidy.output).toBe("hi\nls: cannot access '/x': No such file")
		expect(tidy.failure).toBe('Exited with code 2')
	})

	it('renders ANSI as plain text', () => {
		expect(tidyTerminalOutput('\u001b[31mred\u001b[0m ok').output).toBe('red ok')
	})

	it('does not dump binary output', () => {
		expect(looksBinary('abc\u0000def')).toBe(true)
		expect(tidyTerminalOutput('PK\u0003\u0004\u0000\u0000').output).toBe(
			'The command printed binary data, which is not shown.',
		)
	})

	it('leaves a long output whole, for the transcript to collapse and Ctrl+O to expand', () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)
		expect(tidyTerminalOutput(lines.join('\n')).output).toBe(lines.join('\n'))
	})

	it('reads the exit code and the streams from facts, not from the text', () => {
		const tidy = tidyCommandOutput(
			{
				kind: 'command',
				command: 'echo hi && ls -la /nonexistent',
				exitCode: 2,
				stdout: { head: 'hi', totalLines: 1, totalBytes: 3 },
				stderr: { head: "ls: cannot access '/nonexistent'", totalLines: 1, totalBytes: 33 },
			},
			// The model's copy, labels and all. The person's body does not use it.
			"STDOUT:\nhi\n\nSTDERR:\nls: cannot access '/nonexistent'\nError: Command exited with code 2",
		)
		expect(tidy.failure).toBe('Ran echo hi && ls -la /nonexistent · exited with code 2')
		expect(tidy.output).toBe("hi\nls: cannot access '/nonexistent'")
	})

	it('shows the first and last lines of a long stream with a gap line, never the kernel notice', () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)
		const tidy = tidyCommandOutput(
			{
				kind: 'command',
				command: 'seq 200',
				exitCode: 0,
				stdout: {
					head: lines.slice(0, 80).join('\n'),
					tail: lines.slice(-40).join('\n'),
					omittedLines: 80,
					totalLines: 200,
					totalBytes: 1500,
				},
			},
			'STDOUT:\n1\n... 199 similar lines omitted\n\nThe full output was written to: /tmp/x',
		)
		expect(tidy.failure).toBeUndefined()
		expect(tidy.output).toBe([...lines.slice(0, 80), '… 80 lines not shown', ...lines.slice(-40)].join('\n'))
	})

	it('names a timeout, a signal and binary output from the fields', () => {
		expect(
			tidyCommandOutput({ kind: 'command', command: 'sleep 99', timedOut: true }, '').failure,
		).toBe('Ran sleep 99 · timed out')
		expect(
			tidyCommandOutput({ kind: 'command', command: 'x', signal: 'SIGKILL' }, '').failure,
		).toBe('Ran x · was stopped before it finished')
		expect(
			tidyCommandOutput({ kind: 'command', command: 'cat a.zip', exitCode: 0, binary: { bytes: 2048 } }, '')
				.output,
		).toBe('The command printed binary data (2.0 KB), which is not shown.')
	})

	it('says one sentence for a tool that does not exist, listing no internal names', () => {
		const text = unknownToolNotice('Error: Unknown tool "read_file". Available: bash, edit, glob')
		expect(text).toBe(
			'The model asked for a tool that does not exist (read_file). It will try another way.',
		)
		expect(text).not.toContain('bash')
		expect(unknownToolNotice('Error: something else')).toBeUndefined()
	})
})
