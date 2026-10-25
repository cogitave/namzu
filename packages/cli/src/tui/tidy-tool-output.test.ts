import { describe, expect, it } from 'vitest'

import {
	declinedLine,
	factsHeadline,
	failureFactsLine,
	looksBinary,
	tidyCommandOutput,
	tidyTerminalOutput,
	unknownToolNotice,
} from './tidy-tool-output.js'

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
		expect(tidy.output).toBe([...lines.slice(0, 80), '… +80 lines', ...lines.slice(-40)].join('\n'))
	})

	it('names a timeout, a signal and binary output from the fields', () => {
		expect(
			tidyCommandOutput({ kind: 'command', command: 'sleep 99', timedOut: true }, '').failure,
		).toBe('Ran sleep 99 · timed out')
		expect(
			tidyCommandOutput({ kind: 'command', command: 'x', signal: 'SIGKILL' }, '').failure,
		).toBe('Ran x · was stopped before it finished')
		expect(
			tidyCommandOutput(
				{ kind: 'command', command: 'cat a.zip', exitCode: 0, binary: { bytes: 2048 } },
				'',
			).output,
		).toBe('The command printed binary data (2 KB), which is not shown.')
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

describe('a call the person declined', () => {
	it('says so in one sentence, with their words when they gave any', () => {
		expect(declinedLine(undefined)).toBe('You declined this, so it did not run.')
		expect(declinedLine('  not now \n please ')).toBe(
			'You declined this, so it did not run. You said: “not now please”',
		)
	})
})

describe('a call the kernel refused or could not do', () => {
	it('reads as a sentence, never as the refusal text the model was given', () => {
		expect(failureFactsLine({ kind: 'failure', reason: 'blocked', subject: 'bash' })).toBe(
			'Blocked: Namzu’s rules do not allow this here.',
		)
		expect(failureFactsLine({ kind: 'failure', reason: 'not_found', subject: '/srv/x/a.ts' })).toBe(
			'Couldn’t find /srv/x/a.ts.',
		)
		expect(failureFactsLine({ kind: 'failure', reason: 'needs_administrator' })).toBe(
			'Blocked: this command needs administrator rights.',
		)
	})
})

describe('the headline of a read, search, write or edit', () => {
	it('reads a file by its name, whatever folder it is in', () => {
		expect(factsHeadline({ kind: 'read', path: '/home/me/app/src/a.ts' })).toBe('Read a.ts')
		expect(factsHeadline({ kind: 'read', path: 'C:\\app\\a.ts' })).toBe('Read a.ts')
		expect(factsHeadline({ kind: 'read', path: 'logo.png', binary: true })).toBe(
			'Read logo.png · not text',
		)
		expect(
			factsHeadline({
				kind: 'read',
				path: 'big.log',
				partial: true,
				returnedLines: 200,
				totalLines: 12400,
			}),
		).toBe('Read big.log · 200 of 12,400 lines')
	})

	it('counts matches and files for a search', () => {
		expect(
			factsHeadline({
				kind: 'search',
				pattern: 'x',
				matches: 2,
				filesMatched: 2,
				filesSearched: 9,
			}),
		).toBe('Searched for x · 2 matches in 2 files')
		expect(factsHeadline({ kind: 'search', pattern: 'x', matches: 1, filesMatched: 1 })).toBe(
			'Searched for x · 1 match in 1 file',
		)
		expect(factsHeadline({ kind: 'search', pattern: 'x', matches: 0 })).toBe(
			'Searched for x · no matches',
		)
		expect(factsHeadline({ kind: 'search', pattern: 'x', matches: 5, truncated: true })).toBe(
			'Searched for x · 5 matches, more not shown',
		)
		expect(factsHeadline({ kind: 'search', pattern: 'x' })).toBe('Searched for x')
	})

	it('says what a write did, with the lines it added and removed', () => {
		expect(
			factsHeadline({
				kind: 'write',
				path: '/p/n.txt',
				operation: 'created',
				added: 2,
				removed: 0,
			}),
		).toBe('Created n.txt +2')
		expect(
			factsHeadline({ kind: 'write', path: 'a.ts', operation: 'updated', added: 2, removed: 1 }),
		).toBe('Updated a.ts +2 −1')
		expect(factsHeadline({ kind: 'write', path: 'a.ts', operation: 'unchanged' })).toBe(
			'No changes to a.ts',
		)
	})

	it('headlines an edit from the counts the kernel reported', () => {
		expect(
			factsHeadline({ kind: 'edit', path: '/p/a.ts', replacements: 1, added: 2, removed: 1 }),
		).toBe('Edited a.ts +2 −1')
		expect(factsHeadline({ kind: 'edit', path: 'a.ts' })).toBe('Edited a.ts')
		// A final-newline-only change is one line on each side and is never hidden.
		expect(factsHeadline({ kind: 'edit', path: 'a.ts', added: 1, removed: 1 })).toBe(
			'Edited a.ts +1 −1',
		)
	})

	it('has no opinion on anything else, so a saved conversation keeps its text', () => {
		expect(factsHeadline(undefined)).toBeUndefined()
		expect(factsHeadline({ kind: 'failure', reason: 'not_found' })).toBeUndefined()
		expect(factsHeadline({ kind: 'command' })).toBeUndefined()
	})
})

describe('the shell cell data', () => {
	const facts = (more: object) => ({ kind: 'command' as const, command: 'x', ...more })

	it('keeps stdout and stderr apart and leads a failure with its exit status', () => {
		const { shell } = tidyCommandOutput(
			facts({
				exitCode: 3,
				stdout: { head: 'a\nb', totalLines: 2, totalBytes: 3 },
				stderr: { head: 'boom', totalLines: 1, totalBytes: 4 },
			}),
			'',
		)
		expect(shell).toEqual({
			stdout: ['a', 'b'],
			stderr: ['boom'],
			failed: true,
			status: 'Exit code 3',
			note: 'Exit code 3',
		})
	})

	it('says a failed command with no output only by its exit code', () => {
		const { shell } = tidyCommandOutput(facts({ exitCode: 3 }), '')
		expect(shell).toMatchObject({ stdout: [], stderr: [], failed: true, note: 'Exit code 3' })
		expect(shell?.status).toBeUndefined()
	})

	it('names a timeout and a signal in a few words, not the command', () => {
		expect(tidyCommandOutput(facts({ timedOut: true }), '').shell?.note).toBe('Timed out')
		expect(tidyCommandOutput(facts({ signal: 'SIGKILL' }), '').shell?.note).toBe(
			'Stopped before it finished',
		)
	})

	it('replaces the model-facing background text with one plain line', () => {
		const { shell } = tidyCommandOutput(
			facts({ background: true }),
			'Started background job job_1. For finite work, await completion with wait_for_job: {"id":"job_1"}.',
		)
		expect(shell).toEqual({
			stdout: [],
			stderr: [],
			failed: false,
			note: 'Running in the background (↓ to manage)',
		})
	})

	it('reads a conversation saved before facts the same way', () => {
		const failed = tidyTerminalOutput('partial\nError: Command exited with code 2').shell
		expect(failed).toMatchObject({
			stdout: ['partial'],
			failed: true,
			status: 'Exit code 2',
		})
		expect(
			tidyTerminalOutput('Started background job job_2. For finite work, wait.').shell?.note,
		).toBe('Running in the background (↓ to manage)')
	})
})

describe('a file that is not in the working folder', () => {
	it('is named under home or in full, never as ../../x', () => {
		const line = failureFactsLine(
			{ kind: 'failure', reason: 'not_found', subject: '../../etc/x.conf' },
			'/work/proj',
		)
		expect(line).not.toContain('..')
		expect(line).toBe('Couldn’t find /etc/x.conf.')
	})

	it('leaves a tool name alone', () => {
		expect(failureFactsLine({ kind: 'failure', reason: 'unknown_tool', subject: 'ls' }, '/w')).toBe(
			'The model asked for a tool that does not exist (ls). It will try another way.',
		)
	})
})
