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
import {
	type FloorReason,
	floorRefusal,
	scheduledRunFloorFinding,
	scheduledRunFloorRule,
	scheduledRunFloorVerdict,
} from '../floor.js'

const USER = '/home/u'
const HOME = '/home/u/.namzu'
const FOLDER = '/home/u/work/project'

const verdict = scheduledRunFloorVerdict({
	namzuHome: HOME,
	userHome: USER,
	folders: [FOLDER],
	daemonCommandLine: 'node /usr/lib/node_modules/@namzu/cli/dist/bin.js schedule daemon',
})

const finding = scheduledRunFloorFinding({
	namzuHome: HOME,
	userHome: USER,
	folders: [FOLDER],
	daemonCommandLine: 'node /usr/lib/node_modules/@namzu/cli/dist/bin.js schedule daemon',
})

/** What a refusal of `command` says matched, or null. */
function detail(command: string, dialect: 'bash' | 'sh' = 'bash'): string | null {
	return (
		finding({
			toolName: 'bash',
			toolInput: { command },
			toolDef: undefined,
			commandDialect: dialect,
		})?.detail ?? null
	)
}

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

	// A security review of the command-substitution fix (668557ae) found
	// that `named()` read a wild (expanding) program-name word as NOT being
	// `pkill`/`systemctl`/etc. unless its raw, unevaluated text happened to
	// contain the tool's name as one contiguous run — `$(echo pk)ill` never
	// does, since `)` sits between "pk" and "ill". The tripwire's own
	// text-scan has the same gap for the same reason. A wild word in the
	// program-name position (the head, or right after a `sudo`/`env`-style
	// re-exec prefix) now counts as being every tool this checks for, never
	// as being none of them.
	it('reads a wild program name as possibly being the tool, however its raw text is split', () => {
		denied([
			'$(echo pk)ill -f node',
			'$(echo pk)ill -f namzu',
			'$(echo system)ctl stop namzu-scheduler.service',
			'$(echo system)ctl stop $(echo namzu)-scheduler.service',
			'`echo pk`ill -f node',
			'sudo $(echo systemctl) stop namzu-scheduler',
			'$(echo launch)ctl bootout gui/501/com.namzu.scheduler',
			'$(echo sch)tasks -delete -tn namzu',
			'$(echo bus)ctl call org.freedesktop.systemd1 /x y StopUnit ss namzu-scheduler.service fail',
		])
	})

	// A second review of that fix found `heads` only ever placed the program
	// one word after a fixed, one-hop list of wrapper names (`REEXEC_PREFIX`),
	// so any wrapper with a MANDATORY argument of its own before the program
	// — `timeout`'s duration, `stdbuf`'s buffering mode, `chrt`'s priority, an
	// `env VAR=value` pair — put the program at the wrong index and reached
	// it as an ordinary, unverified argument. `exec` and `command` were not
	// in the list at all. `programPositions` (`packages/sdk/src/
	// authorization/program.ts`) replaces the fixed-offset guess with each
	// wrapper's own real option grammar, and follows a chain of several.
	it('places the program correctly behind a wrapper that takes its own argument first', () => {
		denied([
			'timeout 5 $(echo systemctl) stop namzu-scheduler.service',
			'timeout -s TERM 5 $(echo systemctl) stop namzu-scheduler.service',
			'stdbuf -oL $(echo systemctl) stop namzu-scheduler.service',
			'chrt 0 $(echo systemctl) stop namzu-scheduler.service',
			'env NODE_ENV=production $(echo systemctl) stop namzu-scheduler.service',
			'nice -n 10 $(echo systemctl) stop namzu-scheduler.service',
			'ionice -c2 -n7 $(echo systemctl) stop namzu-scheduler.service',
			'exec $(echo systemctl) stop namzu-scheduler.service',
			'command $(echo systemctl) stop namzu-scheduler.service',
			'timeout 5 $(echo pkill) -f namzu-scheduler',
			'env NODE_ENV=production $(echo pkill) -f namzu-scheduler',
			// Chained wrappers, followed all the way through — no longer
			// stopping after one hop.
			'sudo nice $(echo systemctl) stop namzu-scheduler.service',
			'sudo env nice -n 5 $(echo systemctl) stop namzu-scheduler.service',
		])
		// A wrapper's idiomatic, attached-short-option spelling must not, on
		// its own, make an otherwise ordinary command unverifiable: fail
		// closed on an option this does not model, not on the everyday form
		// of one it does.
		allowed([
			'ionice -c2 -n7 rsync -a /src /dst',
			'nice -n10 make -j4',
			'stdbuf -oL grep foo',
			'taskset -c0-3 make -j4',
		])
	})

	it('does not read a wild word as a program name where it plainly is not one', () => {
		// Negative controls: a literal program name with substitutions only
		// in its arguments still behaves exactly as before (allowed, or
		// denied, on its own established grounds), and an ordinary wild
		// word (a glob, a tilde, an unrelated substitution) in a command
		// unrelated to these tools is not, on its own, read as reaching
		// them — a wild word only stands for "could be this tool" in the
		// program-name position, not anywhere a wild word appears.
		allowed([
			'rm -rf /tmp/*.log',
			'echo $(date) > /tmp/x',
			'ls ~/documents',
			'sudo systemctl stop unrelated-service',
			'find . -name "*.tmp" -delete',
		])
		// A wild PATTERN argument to a literal pkill/systemctl is a
		// different, already-established rule (any wild pattern/unit is
		// unverifiable) and stays denied, unaffected by this fix.
		denied(['pkill -f $(echo node)', 'systemctl stop $(echo unrelated).service'])
	})

	it('reads a variable in the program path as unknown too, since its value is unknown', () => {
		// `"$HOME"/bin/systemctl` is `expands: true` (it holds `$HOME`) even
		// though the literal suffix already unambiguously says `systemctl`:
		// this errs toward the safe side (still denied) rather than trying
		// to read a partially-known program-name word more precisely. An
		// unrelated variable-headed command is unaffected.
		denied(['"$HOME"/bin/systemctl stop namzu-scheduler'])
		allowed(['$MYTOOL --version'])
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
		denied([
			'$(echo namzu) schedule stop',
			'eval "$CMD" # namzu schedule stop',
			'$S --user stop namzu-scheduler',
		])
		allowed([
			'echo "$(date)" >> run.log',
			'eval "$CMD"',
			'x=$(git rev-parse HEAD)',
			// The product's name is not a way to the scheduler.
			'eval "$CMD" # namzu',
		])
	})
})

describe('the tripwire, on text a program runs as code', () => {
	// A scheduled job's only command, refused on the operator's first trial
	// because the text said "Namzu" (and "scheduled").
	const trial = `powershell.exe -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Namzu: scheduled job çalışıyor','Namzu')"`

	it('does not deny the product’s name, or "scheduled", in a string', () => {
		allowed([trial])
		allowed([trial], 'sh')
		allowed([
			`powershell.exe -NoProfile -Command "Write-Host 'namzu finished the scheduled run'"`,
			`powershell.exe -NoProfile -Command "(New-Object -ComObject WScript.Shell).Popup('Namzu is running a scheduled job', 5, 'Namzu')"`,
			'powershell.exe -NoProfile -Command "Get-ScheduledTask | Select-Object TaskName"',
			`cmd.exe /c "echo Namzu scheduled job & msg * Namzu"`,
			`python3 -c "print('Namzu: scheduled job done')"`,
			`python3 -c "print('the next schedule is tomorrow')"`,
			`python3 -c $'print(\'the next schedule is tomorrow\')'`,
			`node -e "console.log('namzu scheduled run')"`,
			`echo 'notify-send Namzu "scheduled job done"' | sh`,
			`sh <<'EOF'\nnotify-send Namzu "scheduled job done"\nEOF`,
			`echo 'namzu schedule list && namzu schedule history nightly' | sh`,
		])
	})

	it('denies what can reach the scheduler, NAMZU_HOME or the browser profiles', () => {
		denied([
			// The CLI with a `schedule` subcommand that changes something.
			'powershell.exe -NoProfile -Command "namzu schedule stop"',
			'powershell -Command "wsl namzu schedule remove nightly"',
			'powershell.exe -Command "& $cli schedule remove nightly"',
			`python3 -c "import subprocess; subprocess.run(['namzu','schedule','remove','x'])"`,
			`python3 -c "import subprocess; subprocess.run(['node', '/opt/cli/dist/bin.js', 'schedule', 'stop'])"`,
			`node -e "require('child_process').execSync('npx @namzu/cli schedule pause x')"`,
			'xargs -a jobs.txt namzu schedule',
			// The service, by name or by tool.
			'powershell.exe -NoProfile -Command "Stop-ScheduledTask -TaskName namzu-scheduler-wsl-archlinux"',
			`powershell.exe -Command "Unregister-ScheduledTask -TaskPath '\\namzu\\' -Confirm:$false"`,
			'cmd.exe /c "schtasks /end /tn \\namzu\\namzu-scheduler"',
			`python3 -c "import os; os.system('systemctl --user stop namzu-scheduler')"`,
			`python3 -c "import os; os.system('launchctl bootout gui/501/com.namzu.scheduler')"`,
			`python3 -c "import os; os.system('pkill -f node')"`,
			// NAMZU_HOME.
			'powershell.exe -Command "Remove-Item $env:USERPROFILE\\.namzu -Recurse"',
			`python3 -c "import shutil, os; shutil.rmtree(os.path.expanduser('~/.namzu'))"`,
			`python3 -c "import os; print(open(os.environ['NAMZU_HOME'] + '/x').read())"`,
			'cmd.exe /c "type %NAMZU_HOME%\\schedule\\daemon\\endpoint.json"',
			`node -e "console.log(process.env.NAMZU_HOME)"`,
			// The Windows browser's profiles.
			`powershell.exe -Command "Remove-Item (Join-Path $env:LOCALAPPDATA 'namzu') -Recurse"`,
			`powershell.exe -Command "Get-Content (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'namzu\\browser')"`,
			'cmd.exe /c "rmdir /s /q %LOCALAPPDATA%\\namzu"',
		])
	})

	it('reads text given to a shell with -c when the lexer did not follow it', () => {
		// The lexer reads the `-c` payload of sh, bash, dash, zsh, ksh, ash and
		// mksh only. `-c` after any other shell was taken as read too, so
		// these ran unread and untripped.
		denied([
			"powershell -c 'namzu schedule stop'",
			"powershell.exe -c 'Stop-ScheduledTask -TaskName namzu-scheduler-wsl-archlinux'",
			"pwsh -command 'namzu schedule stop'",
			"fish -c 'namzu schedule stop'",
			"tcsh -c 'systemctl --user stop namzu-scheduler'",
			"bash.exe -c 'namzu schedule stop'",
			"bash script.sh -c 'namzu schedule stop'",
		])
		// What the lexer did follow is still read, not tripped over.
		allowed(["bash -c 'npm test && echo namzu-scheduler'", "busybox sh -c 'echo hi'"])
	})

	it('names the rule that matched, and where, instead of everything it protects', () => {
		expect(detail('powershell.exe -NoProfile -Command "namzu schedule stop"')).toBe(
			'`powershell.exe` runs commands the floor does not read, and it holds `schedule stop` (a `namzu schedule` subcommand other than list, show, status, history, logs), in the argument `namzu schedule stop`',
		)
		expect(
			detail(
				'powershell.exe -NoProfile -Command "Stop-ScheduledTask -TaskName namzu-scheduler-wsl-archlinux"',
			),
		).toContain("`namzu-scheduler-wsl-archlinux` (the scheduler service's name)")
		expect(detail(`python3 -c "import os; os.system('pkill node')"`)).toMatch(
			/^`python3` runs text as code, and it holds `pkill` /,
		)
		// `$(echo namzu)` is now read as a nested command line, not opaque
		// outright. A wild head word is now read as being every program name
		// this checks for (a security-review fix: it used to be read as
		// definitely not being `pkill`/`killall`, missing a wild head glued
		// to nothing — see the "reaches the scheduler" describe block
		// below), so this is caught earlier and more broadly, by the
		// pkill/killall check (any word holding `namzu` or `schedul`,
		// `schedule` included, after a head that could be either), rather
		// than needing the narrower "unread text" path this test exercised
		// before that fix.
		expect(detail('$(echo namzu) schedule stop')).toBe(
			"`$(echo namzu) schedule stop` has a pattern that could match the scheduler's process",
		)
		expect(detail('systemctl --user stop namzu-scheduler')).toBe(
			"`systemctl --user stop namzu-scheduler` stops or disables the scheduler's service",
		)
		expect(detail('namzu schedule remove nightly')).toBe(
			'`namzu schedule remove nightly` runs `schedule remove`, a `namzu schedule` subcommand other than list, show, status, history, logs',
		)
		expect(detail('cat ~/.namzu/config.yaml')).toBe(
			'the argument `~/.namzu/config.yaml` names NAMZU_HOME (/home/u/.namzu)',
		)
		expect(detail('echo x >> ~/.namzu/x')).toBe(
			'the redirection `>> ~/.namzu/x` names NAMZU_HOME (/home/u/.namzu)',
		)
		expect(detail('ls /mnt/c/Users/A/AppData/Local/namzu')).toBe(
			"the argument `/mnt/c/Users/A/AppData/Local/namzu` names the Windows browser's profile folder (%LOCALAPPDATA%\\namzu)",
		)
		expect(
			finding({
				toolName: 'write',
				toolInput: { path: 'notes.md', content: 'see ~/.namzu' },
				toolDef: undefined,
				commandDialect: 'sh',
			})?.detail,
		).toBe('the `content` argument names NAMZU_HOME (/home/u/.namzu)')
		expect(
			finding({
				toolName: 'mcp_tool',
				toolInput: { args: [{ dir: '~/.namzu' }] },
				toolDef: undefined,
				commandDialect: 'sh',
			})?.detail,
		).toBe('the `args[0].dir` argument names NAMZU_HOME (/home/u/.namzu)')
	})

	it('gives the gate that reason for the call it refused', () => {
		const rule = scheduledRunFloorRule({ namzuHome: HOME, userHome: USER, folders: [FOLDER] })
		const call = {
			toolName: 'bash',
			toolInput: { command: 'cat ~/.namzu/x' },
			toolDef: undefined,
			commandDialect: 'bash' as const,
		}
		expect(rule.type === 'predicate' && rule.decide(call)).toBe('deny')
		expect(rule.type === 'predicate' && rule.describe?.(call)).toBe(
			floorRefusal({
				reason: 'word names NAMZU_HOME',
				detail: 'the argument `~/.namzu/x` names NAMZU_HOME (/home/u/.namzu)',
			}),
		)
		expect(
			rule.type === 'predicate' && rule.describe?.({ ...call, toolInput: { command: 'ls' } }),
		).toBeNull()
	})
})

describe("PowerShell's -EncodedCommand", () => {
	// Real base64 of UTF-16LE `Write-Host hi`: unreadable text, denied
	// whatever it decodes to, unlike `-Command '<literal>'`.
	const ENCODED = 'VwByAGkAdABlAC0ASABvAHMAdAAgAGgAaQA='

	it('is refused outright: the payload cannot be read at all, so it is never given the benefit of the tripwire finding nothing', () => {
		denied([
			`powershell.exe -EncodedCommand ${ENCODED}`,
			`powershell -encodedcommand ${ENCODED}`,
			`pwsh -EncodedCommand ${ENCODED}`,
			`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${ENCODED}`,
			`powershell -e ${ENCODED}`,
			`powershell -en ${ENCODED}`,
			`powershell -enc ${ENCODED}`,
			`powershell -Enc ${ENCODED}`,
			// Nested inside a followed shell, and inside unread text a program runs.
			`bash -c "powershell.exe -EncodedCommand ${ENCODED}"`,
			`sudo bash -c 'powershell -EncodedCommand ${ENCODED}'`,
		])
	})

	it('does not deny -Command with literal text, which the tripwire can still read', () => {
		allowed([`powershell.exe -NoProfile -Command "Write-Host hi"`])
	})

	it('names the rule that matched', () => {
		expect(detail(`powershell.exe -EncodedCommand ${ENCODED}`)).toMatch(
			/runs a base64-encoded script the floor cannot read at all/,
		)
	})
})

describe('trap', () => {
	it('reads a trap action as a command line, against both protected targets', () => {
		denied([
			"trap 'rm -rf ~/.namzu' EXIT",
			"trap 'cat ~/.namzu/schedule/daemon/endpoint.json' EXIT",
			"trap 'systemctl --user stop namzu-scheduler' EXIT",
			"trap 'namzu schedule stop' INT TERM",
			// Flags before the action; the action is still the first non-flag word.
			"trap -- 'namzu schedule remove nightly' EXIT",
		])
	})

	it('does not deny a benign action, or a bare query/reset', () => {
		allowed(['trap \'echo "cleaning up"\' EXIT', 'trap - EXIT', 'trap -p', 'trap -l'])
	})

	it('names the reason', () => {
		expect(bash("trap 'rm -rf ~/.namzu' EXIT")).toBe('unread text mentions a protected name')
	})
})

describe('find -exec/-execdir/-ok/-okdir', () => {
	it('refuses {} standing for NAMZU_HOME: a broad or unknown root', () => {
		denied([
			'find / -name .namzu -exec rm -rf {} \\;',
			'find ~ -maxdepth 2 -exec cat {}/schedule/daemon/endpoint.json \\;',
			'find ~ -exec rm -rf {} +',
			'find "$DIR" -exec rm -rf {} \\;',
			'find / -iname "*.NAMZU*" -okdir rm -rf {} \\;',
			'find / -path "*/.namzu/*" -exec cat {} \\;',
		])
	})

	it('refuses {} beside a tool that can stop or remove a service, whatever the root', () => {
		denied([
			'find / -name "namzu-scheduler*" -exec systemctl stop {} \\;',
			'find /proc -maxdepth 1 -exec systemctl stop {} \\;',
			'find /proc -exec pkill -f {} \\;',
			'find / -name "*.plist" -execdir launchctl bootout {} \\;',
		])
	})

	it('does not deny find confined to the job’s own folder, or with no {} placeholder at all', () => {
		allowed([
			'find . -name "*.txt" -exec grep -l TODO {} \\;',
			'find . -exec cat {} \\;',
			'find /tmp -exec cat {} \\;',
			'find /tmp/build -type f -delete',
			// No {}: whatever runs is fully static and already read normally.
			'find / -exec echo hi \\;',
			'find . -maxdepth 1 -name "*.log" -exec rm {} \\;',
		])
	})

	it('names the reason', () => {
		expect(bash('find / -name .namzu -exec rm -rf {} \\;')).toBe(
			'find -exec reaches a protected target',
		)
		expect(detail('find / -name .namzu -exec rm -rf {} \\;')).toContain(
			'the floor cannot verify what {} will stand for',
		)
	})
})

describe('a file the script writes, then executes', () => {
	it('refuses running a file written earlier in the SAME line, however it was written', () => {
		denied([
			'cp payload.sh run.sh; bash run.sh',
			'mv staged.sh run.sh; sh run.sh',
			'echo "$PAYLOAD" > run.sh; ./run.sh',
			'printf "%s" "$PAYLOAD" >> run.sh; . run.sh',
			'tee run.sh <<< "$PAYLOAD"; source run.sh',
		])
	})

	it('is content-agnostic: refused whether the write looks like a scheduler attack or a NAMZU_HOME one', () => {
		denied([
			// The written content is opaque (an external file, a variable) —
			// this refuses on the SHAPE alone, not on reading what run.sh holds.
			'cp attacker-controlled.sh run.sh; bash run.sh',
			'echo "$SECRET_PAYLOAD" > run.sh; bash run.sh',
		])
	})

	it('does not deny writing a file and only reading it, or executing an UNRELATED file', () => {
		allowed([
			'echo hi > x.sh; cat x.sh',
			'echo hi > x.sh; bash y.sh',
			'cp a.txt b.txt; wc -l b.txt',
			// A file already on disk before the script ran is not tracked as written.
			'bash existing.sh',
		])
	})

	it('names the reason', () => {
		expect(bash('echo hi > run.sh; bash run.sh')).toBe('runs a file the script wrote earlier')
		expect(detail('echo hi > run.sh; bash run.sh')).toContain(
			'its content cannot be verified, so it is refused rather than run unattended',
		)
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
			// After an unknown variable, the name is not a path segment here.
			'echo "$USER: namzu done"',
			'notify-send "$JOB" "namzu finished"',
		])
	})

	it('reaches inside a command substitution or backtick body, the same as it would read outside one', () => {
		// `$(…)`/backtick content is read as a nested command line and
		// checked by this same, structural resolution — not only by the
		// tripwire's text scan, which a name split across two otherwise
		// harmless-looking words (`D=~/.nam` then `${D}zu`, never ".namzu"
		// as one substring anywhere in the line) would not catch.
		denied([
			'echo $(cat ../../.namzu/x)',
			'echo `cat ../../.namzu/x`',
			'echo $(D=~/.nam; ls ${D}zu)',
			'x=$(cd /tmp && cat ../home/u/.namzu/x)',
			'echo $(echo $(cat ~/.namzu/config.yaml))',
		])
		allowed(['echo $(cat .git/x)', 'echo `echo hi`', 'a=$(echo hi)', 'echo $(basename "$PWD")'])
	})

	it('reads a line in both dialects when the shell may be bash or sh', () => {
		// In `sh`, `$'…'` is opaque; the bash reading still decides.
		denied(["cat $'/home/u/.n\\x61mzu/x'"], 'sh')
		denied(["echo $'hi' # namzu schedule stop"], 'sh')
		allowed(["echo $'hi' # namzu schedule stop"], 'bash')
		allowed(["echo $'hi'", "echo $'hi' # namzu"], 'sh')
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

describe('the Windows browser’s profiles', () => {
	// `%LOCALAPPDATA%\namzu`, where namzu keeps the profiles it drives from
	// WSL. The generated lines behind these were run with the profile tree at
	// /mnt/c/Users/u/AppData/Local/namzu and LOCALAPPDATA set the way a
	// scheduled run inherits it, `C:\Users\u\AppData\Local`.
	it('denies a word or redirection that could name the profile root', () => {
		denied([
			'ls /mnt/c/Users/Arda/AppData/Local/namzu/browser',
			"cat '/mnt/c/Users/A/appdata/local/NAMZU/x'",
			"ls '/mnt/c/Users/A/App''Data/Local/na'mzu",
			'ls /mnt/c/Users/A/AppData//Local/./namzu',
			'ls /mnt/c/Users/A/AppData/Local/../Local/namzu',
			'tar czf /tmp/x.tgz /mnt/c/Users/A/AppData/Local/namzu',
			'echo x > /mnt/c/Users/A/AppData/Local/namzu/browser/profiles/work/Cookies',
			'ls $LOCALAPPDATA/namzu/browser/profiles',
			'ls "${LOCALAPPDATA}"/namzu',
			"ls 'C:\\Users\\A\\AppData\\Local\\namzu'",
			"cmd.exe /c 'type %LOCALAPPDATA%\\namzu\\browser'",
			"powershell.exe -c 'Remove-Item $env:LOCALAPPDATA\\namzu -Recurse'",
			'cd /mnt/c/Users/A/AppData/Local && rm -rf namzu',
			'cd /mnt/c/Users/A/AppData && ls Local/namzu',
			'D=/mnt/c/Users/A/AppData/Local/namzu; cat $D/x',
			'for p in /mnt/c/Users/A/AppData/Local/nam; do ls ${p}zu; done',
			'ls /mnt/c/Users/*/AppData/Local/nam*',
			'ls /mnt/c/Users/A/AppData/Local/*',
			'ls /mnt/c/Users/A/$X/namzu',
		])
	})

	it('names the profiles as the reason', () => {
		expect(bash('ls /mnt/c/Users/A/AppData/Local/namzu')).toBe('word names the browser profiles')
		expect(bash('echo x > $LOCALAPPDATA/namzu/x')).toBe('redirection names the browser profiles')
	})

	it('does not deny another folder, or what bash reads as another path', () => {
		allowed([
			'ls /mnt/c/Users/A/AppData/Local/namzu2',
			'ls /mnt/c/Users/A/AppData/Local/namzu.bak',
			'ls /mnt/c/Users/A/AppData/Local/Google',
			'ls /mnt/c/Users/A/AppData/Roaming/namzu',
			'cat /mnt/c/Users/A/Documents/report.txt',
			'grep -rn AppData src',
			'echo namzu',
			'ls */*/*',
			'ls $X/notes',
			// Unquoted, bash drops the backslashes: `C:UsersAAppDataLocalnamzu`, a file here.
			'dir C:\\Users\\A\\AppData\\Local\\namzu',
		])
	})

	it('denies it in every other tool’s arguments', () => {
		const call = (toolInput: unknown) =>
			verdict({ toolName: 'read', toolInput, toolDef: undefined, commandDialect: 'bash' })
		expect(
			call({ path: 'C:\\Users\\A\\AppData\\Local\\namzu\\browser\\profiles\\x\\Cookies' }),
		).toBe('names the browser profiles')
		expect(call({ path: '/mnt/c/Users/A/AppData/Local/namzu' })).not.toBeNull()
		expect(call({ path: '%LOCALAPPDATA%\\namzu' })).not.toBeNull()
		expect(call({ args: ['$env:LOCALAPPDATA/namzu'] })).not.toBeNull()
		expect(call({ path: '/mnt/c/Users/A/AppData/Local/namzu2/x' })).toBeNull()
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
			'AppData/Local/',
			'*/Local/',
		]) {
			const time = (length: number): number => {
				const command = `${filler.repeat(Math.ceil(length / filler.length))}x`
				const started = performance.now()
				bash(command)
				return performance.now() - started
			}
			time(16_000)
			const small = Math.max(time(16_000), 0.5)
			const large = time(160_000)
			// Ten times the input: linear is about ten times the time, quadratic
			// a hundred. The absolute bound is loose because CI machines run
			// this several times slower than a developer's: the slowest shape,
			// a line of `cd`s, takes about 500 ms here and 1.8 s on CI.
			expect(large / small, filler).toBeLessThan(40)
			expect(large, filler).toBeLessThan(6000)
		}
	})

	it('denies rather than enumerate a word with too many spellings', () => {
		const assignments = Array.from({ length: 8 }, (_, i) => `A=${i}; B=${i}; C=${i}`).join('; ')
		expect(bash(`${assignments}; ls $A$B$C`)).toBe('too many spellings')
	})
})
