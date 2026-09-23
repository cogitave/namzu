/**
 * The scheduled-run floor, decided on the SDK lexer's reading of a command
 * line. Every line here was run in a sandboxed bash that recorded each
 * command's arguments, working directory and open files (see
 * `docs/cli/scheduled-tasks.md#what-a-run-may-do`). A line allowed here
 * reached neither the scheduler nor NAMZU_HOME there. A line denied here
 * reached one of them, or holds what the floor cannot know and could: an
 * unset variable, an exported assignment, text it cannot read that names
 * what it protects.
 */

import { describe, expect, it } from 'vitest'
import { type FloorReason, scheduledRunFloorVerdict } from '../floor.js'

const USER = '/home/u'
const HOME = '/home/u/.namzu'
const FOLDER = '/home/u/work/project'

const verdict = scheduledRunFloorVerdict({
	namzuHome: HOME,
	userHome: USER,
	folders: [FOLDER],
	daemonCommandLine: 'node /usr/lib/node_modules/@namzu/cli/dist/bin.js schedule daemon',
})

function bash(command: string, dialect: 'bash' | 'sh' = 'bash'): FloorReason | null {
	return verdict({
		toolName: 'bash',
		toolInput: { command },
		toolDef: undefined,
		commandDialect: dialect,
	})
}

function denied(lines: readonly string[], dialect: 'bash' | 'sh' = 'bash') {
	for (const line of lines) expect(bash(line, dialect), line).not.toBeNull()
}

function allowed(lines: readonly string[], dialect: 'bash' | 'sh' = 'bash') {
	for (const line of lines) expect(bash(line, dialect), line).toBeNull()
}

describe('the scheduler’s own commands', () => {
	it('denies them behind any wrapper, in a nested shell, or in any order a tool accepts', () => {
		denied([
			'sudo systemctl --user stop namzu-scheduler',
			'env A=1 nohup systemctl --user disable --now namzu-scheduler.service',
			"systemctl --user stop 'namzu*'",
			'systemctl --user isolate default.target',
			'timeout 5 launchctl bootout gui/501/com.namzu.scheduler',
			'schtasks /TN \\namzu\\scheduler /F /Delete',
			'schtasks -delete -tn namzu',
			'pkill node',
			"pkill -f 'schedule daemon'",
			'killall -r nam.u',
			'busctl --user call org.freedesktop.systemd1 /x y StopUnit ss namzu-scheduler.service fail',
			'bash -c "namzu schedule remove nightly"',
			'sh -c \'bash -c "systemctl --user stop namzu-scheduler"\'',
			'./node_modules/.bin/namzu schedule pause x',
			'node $CLI schedule run-now x',
			'namzu $ARGS',
			'namzu schedule "$VERB" x',
			'systemctl --user $VERB namzu-scheduler',
			"n$'\\x61'mzu sch$'\\x65'dule re\\\nmove x",
			'nam$"zu" schedule stop',
		])
	})

	it('does not deny them where bash reads them as data', () => {
		allowed([
			"echo 'systemctl --user stop namzu-scheduler'",
			'grep -rn "namzu schedule remove" docs',
			'git commit -m "stop namzu schedule from firing twice"',
			"printf '%s\\n' 'launchctl bootout gui/501/com.namzu.scheduler'",
			'systemctl --user status namzu-scheduler',
			'namzu schedule list && namzu schedule history nightly --json',
			'pkill -f "vite dev"',
			'echo namzu; ./schedule stop',
		])
	})
})

describe('text that another program runs', () => {
	it('reads it as a command line when the lexer could not follow it', () => {
		denied([
			"echo 'namzu schedule remove x' | sh",
			'bash <<EOF\nsystemctl --user stop namzu-scheduler\nEOF',
			"sudo bash -c 'namzu schedule stop'",
			"echo $'rm -rf /home/u/.n\\x61mzu' | bash",
			"bash <<'EOF'\ncat '/h'$'om\\x65/u/.n\\x61\\x6d\\x7a\\x75/config.yaml'\nEOF",
			'python3 -c "import os; os.system(\'systemctl --user stop namzu-scheduler\')"',
			'xargs -a jobs.txt namzu schedule',
		])
	})

	it('denies an unreadable line that mentions what the floor protects, and only that', () => {
		denied(['$(echo namzu) schedule stop', 'eval "$CMD" # namzu', '$S --user stop namzu-scheduler'])
		allowed(['echo "$(date)" >> run.log', 'eval "$CMD"', 'x=$(git rev-parse HEAD)'])
	})
})

describe('NAMZU_HOME', () => {
	it('denies a word or redirection that resolves into it, however it is spelled', () => {
		denied([
			'cat ~/.namzu/config.yaml',
			'cat "$HOME"/.namzu/x',
			'cat ${HOME}/.namzu/x',
			'ls $NAMZU_HOME',
			'echo x >> ~/.namzu/schedule/jobs/a.json',
			'cat < ~/".namzu"/x',
			"cat /home/u/./.nam''zu/x",
			'cat /home/u/x/../.namzu/x',
			'tool --config=/home/u/.namzu/x',
			'cat ~/.NAMZU/x',
			'X=~/.namzu cmd',
			'export X=~/.namzu',
			'for d in ~/.namzu; do rm -r "$d"; done',
			'case ~/.namzu/x in *) :;; esac',
			'D=~/.namzu; rm -rf "$D"',
			'D=~/.nam; ls ${D}zu',
			'P=$HOME; cat $P/.namzu/x',
			'ls ~/.nam*',
			'ls ~/$X',
			'ls /$X',
			'cat $X/.namzu/config.yaml',
			'cat ../../.namzu/x',
			'cd ~ && rm -rf .namzu',
			'cd /tmp && cat ../home/u/.namzu/x',
			'for i in 1 2; do cat .namzu/x; cd ~; done',
			'cat $PWD/../../.namzu/x',
		])
	})

	it('does not deny what bash reads as another path', () => {
		allowed([
			"echo '~/.namzu'",
			"cat '~'/.namzu",
			'cat ~"/.namzu"',
			'ls ~/.namzu-other ~/.namzu.bak ~/project/.namzu2',
			'ls ~/*',
			'du -sh ~/*',
			'cat .namzu/x',
			'cat .namzu/x; cd ~',
			'X=~/.namzu',
			'ls /tmp/$X',
			'for f in *.ts; do wc -l "$f"; done',
			'cd "$DIR" && ls',
			'tool --config=~/.namzu/x',
		])
	})

	it('reads a line in both dialects when the shell may be bash or sh', () => {
		// In `sh`, `$'…'` is opaque; the bash reading still decides.
		denied(["cat $'/home/u/.n\\x61mzu/x'"], 'sh')
		denied(["echo $'hi' # namzu"], 'sh')
		allowed(["echo $'hi' # namzu"], 'bash')
		allowed(["echo $'hi'"], 'sh')
	})

	it('denies it in every other tool’s arguments, at any depth', () => {
		const call = (toolName: string, toolInput: unknown) =>
			verdict({ toolName, toolInput, toolDef: undefined, commandDialect: 'sh' })
		expect(call('read', { path: '/home/u//.namzu/schedule/daemon/endpoint.json' })).not.toBeNull()
		expect(call('write', { path: 'notes.md', content: 'see $NAMZU_HOME' })).not.toBeNull()
		expect(call('mcp_tool', { args: [{ dir: '~/.nam"z"u' }] })).not.toBeNull()
		expect(call('read', { path: '/home/u/.namzu-other/x' })).toBeNull()
		expect(call('bash', { command: 'ls', description: 'looks in ~/.namzu' })).not.toBeNull()
	})
})

describe('cost', () => {
	it('stays linear on long lines of the shapes it follows', () => {
		for (const filler of [
			'cd x; ',
			'X=a; ',
			"echo 'a b' | sh; ",
			'for d in a; do :; done; ',
			'ls $X$Y; ',
			'sh -c "sh -c \\"a b\\""; ',
			'namzu schedule list; ',
			'~/',
			'$HOME/',
		]) {
			const command = `${filler.repeat(Math.ceil(160_000 / filler.length))}x`
			const started = performance.now()
			bash(command)
			expect(performance.now() - started, filler).toBeLessThan(1500)
		}
	})

	it('denies rather than enumerate a word with too many spellings', () => {
		const assignments = Array.from({ length: 8 }, (_, i) => `A=${i}; B=${i}; C=${i}`).join('; ')
		expect(bash(`${assignments}; ls $A$B$C`)).toBe('too many spellings')
	})
})
