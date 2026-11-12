import { AuthorizationGate, NOOP_LOGGER } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { cliGate } from '../read-only-gate.js'
import { SEND_FLOOR_REASON, findSendInLine } from '../send-floor.js'

const ID = '01a1cf5a-6690-748b-b894-a53c37e9bee2'

/** Every spelling below runs `namzu send` once the line is read; each must be refused. */
const REFUSED: ReadonlyArray<readonly [string, string]> = [
	['the command', `namzu send ${ID} 'approve all'`],
	['a path to the CLI', `/usr/local/bin/namzu send ${ID} hi`],
	['a Windows launcher', `C:\\\\tools\\\\namzu.cmd send ${ID} hi`],
	['the entry script by path', `node packages/cli/dist/bin.js send ${ID} hi`],
	['the entry script by absolute path', `/usr/bin/node /opt/namzu/dist/bin.js send ${ID} hi`],
	['the package through npx', `npx -y @namzu/cli@latest send ${ID} hi`],
	['the package through pnpm', `pnpm dlx @namzu/cli send ${ID} hi`],
	['options before the subcommand', `namzu --json send ${ID} hi`],
	['env in front', `env FOO=1 namzu send ${ID} hi`],
	['env -i', `env -i PATH=/usr/bin namzu send ${ID} hi`],
	['setsid', `setsid namzu send ${ID} hi`],
	['setsid -f', `setsid -f namzu send ${ID} hi`],
	['nohup in the background', `nohup namzu send ${ID} hi > out.txt 2>&1 &`],
	['a subshell in the background', `(namzu send ${ID} hi &)`],
	['timeout', `timeout 5 namzu send ${ID} hi`],
	['nice and sudo', `sudo -n nice -n 5 namzu send ${ID} hi`],
	['sh -c', `sh -c "namzu send ${ID} hi"`],
	['bash -lc', `bash -lc 'namzu send ${ID} hi'`],
	['sh -c inside sh -c', `sh -c "sh -c 'namzu send ${ID} hi'"`],
	['a pipeline', `echo hi | namzu send ${ID}`],
	['after another command', `cd /tmp && namzu send ${ID} hi`],
	['a command substitution', `echo $(namzu send ${ID} hi)`],
	['xargs', `echo ${ID} | xargs -I{} namzu send {} hi`],
	['find -exec', `find . -maxdepth 0 -exec namzu send ${ID} hi \;`],
	['a quoted subcommand', `namzu 'se'nd ${ID} hi`],
	['an escaped subcommand', `namzu s\\end ${ID} hi`],
	['an ANSI-C quoted subcommand', `namzu $'\\x73end' ${ID} hi`],
	['a quoted program name', `'namzu' send ${ID} hi`],
	['a program name that expands, then send', `$(command -v namzu) send ${ID} hi`],
	['a program and an argument that expand', `$A $B ${ID} hi`],
	['a subcommand that expands', `namzu $SUB ${ID} hi`],
	['a script read from standard input', `echo 'namzu send ${ID} hi' | sh`],
	['eval', `eval "namzu send ${ID} hi"`],
	['an interpreter given the text', `python3 -c "import os; os.system('namzu send ${ID} hi')"`],
	['node given the text', `node -e "require('child_process').execSync('namzu send ${ID} hi')"`],
	[
		'a script written and run in one line',
		`printf '#!/bin/sh\\nnamzu send ${ID} hi\\n' > t.sh && setsid -f env -i sh ./t.sh`,
	],
	['a runner that reads a file it was given on its input', `bash <<EOF\nnamzu send ${ID} hi\nEOF`],
]

/** Commands near it that are not the person's channel, or do not run it. They stay with the rules. */
const LEFT_ALONE: ReadonlyArray<readonly [string, string]> = [
	['the agent-to-agent channel', `namzu peers send ${ID} hi`],
	['peers after options', `namzu --json peers send ${ID} hi`],
	['another subcommand', `namzu watch ${ID}`],
	['the version', 'namzu --version'],
	['echoing the words', 'echo namzu send is a command'],
	['printing them', `printf 'namzu send %s' ${ID}`],
	['searching for them', 'grep -rn namzu send docs'],
	['quoting them in a commit message', `git commit -m "docs: namzu send"`],
	['listing the files', 'ls namzu send'],
	['another program with a send subcommand', 'mail send alice'],
	['a package script named send', 'npm run send'],
	['a runtime and a script that is not the CLI', 'node tools/notify.js send'],
	['make', 'make send'],
	['an unrelated pipeline', 'cat file.txt | wc -l'],
]

describe('the send floor reads a command line and refuses a run of `namzu send`', () => {
	it.each(REFUSED)('refuses %s', (_name, line) => {
		expect(findSendInLine(line, 'sh'), line).not.toBeNull()
		expect(findSendInLine(line, 'bash'), line).not.toBeNull()
	})

	it.each(LEFT_ALONE)('leaves %s alone', (_name, line) => {
		expect(findSendInLine(line, 'sh'), line).toBeNull()
		expect(findSendInLine(line, 'bash'), line).toBeNull()
	})

	it('does not see a script the line only runs (the file is not in the line)', () => {
		// Said out loud so the gap stays measured: the marker and process ancestry stop this one.
		expect(findSendInLine('sh ./run.sh', 'sh')).toBeNull()
		expect(findSendInLine('./run.sh', 'bash')).toBeNull()
	})

	it('does not see a name assembled from pieces that never stand together', () => {
		expect(findSendInLine('eval "n=nam; ${n}zu se\'\'nd x"', 'sh')).toBeNull()
		expect(findSendInLine('ln -s "$(command -v namzu)" ./x && ./x send abc', 'sh')).toBeNull()
	})
})

describe('through the gate every session builds', () => {
	const gate = new AuthorizationGate(cliGate([]), NOOP_LOGGER)
	const decide = (command: string, toolName = 'bash') =>
		gate.evaluate({ toolName, toolInput: { command }, toolDef: undefined, commandDialect: 'sh' })

	it('denies with a plain reason, naming what matched', () => {
		const result = decide(`env -i PATH=/usr/bin setsid -f namzu send ${ID} hi`)
		expect(result.decision).toBe('deny')
		expect(result.reason).toContain(SEND_FLOOR_REASON)
		expect(result.reason).toContain('runs `namzu send`')
	})

	it('wins over an operator rule that allows the command', () => {
		const allowing = new AuthorizationGate(
			cliGate([
				{
					type: 'argument_pattern',
					toolNames: ['bash'],
					argument: 'command',
					pattern: '.*',
					decision: 'allow',
				},
			]),
			NOOP_LOGGER,
		)
		const result = allowing.evaluate({
			toolName: 'bash',
			toolInput: { command: `namzu send ${ID} hi` },
			toolDef: undefined,
			commandDialect: 'bash',
		})
		expect(result.decision).toBe('deny')
	})

	it('leaves other tools and the peers channel to the rules after it', () => {
		expect(decide(`namzu peers send ${ID} hi`).reason).not.toContain(SEND_FLOOR_REASON)
		const other = gate.evaluate({
			toolName: 'write',
			toolInput: { path: 'notes.md', content: `namzu send ${ID} hi` },
			toolDef: undefined,
		})
		expect(other.reason ?? '').not.toContain(SEND_FLOOR_REASON)
	})
})
