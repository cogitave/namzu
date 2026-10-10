import { describe, expect, it } from 'vitest'

import { looksBinary, tidyTerminalOutput, unknownToolNotice } from './tidy-tool-output.js'

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

	it('says one sentence for a tool that does not exist, listing no internal names', () => {
		const text = unknownToolNotice('Error: Unknown tool "read_file". Available: bash, edit, glob')
		expect(text).toBe(
			'The model asked for a tool that does not exist (read_file). It will try another way.',
		)
		expect(text).not.toContain('bash')
		expect(unknownToolNotice('Error: something else')).toBeUndefined()
	})
})
