import { describe, expect, it } from 'vitest'

import { shellHookIfMatches } from '../shell-hook.js'

/**
 * What an `if` on a shell command evaluates. The pattern is a permission
 * rule's; each command of the line is tested with its wrappers peeled, its
 * program named by its basename and git's global options dropped. A line the
 * splitter cannot read, or a command whose name is only known when it runs,
 * runs the hook. `[condition, command line, does the hook run]`.
 */
const TABLE: readonly (readonly [string, string, boolean])[] = [
	['Bash(git push *)', 'git push origin main', true],
	['Bash(git push *)', 'git push', true],
	['Bash(git push:*)', 'git push origin main', true],
	['Bash(git push:*)', 'git push', true],
	['Bash(git push *)', 'git status', false],
	['Bash(git push *)', 'cd x && git push origin main', true],
	['Bash(git push *)', 'git add . ; git push origin main', true],
	['Bash(git push *)', 'git fetch || git push origin main', true],
	['Bash(git push *)', 'echo hi | git push origin main', true],
	['Bash(git push *)', '(cd x && git push origin main)', true],
	['Bash(git push *)', 'FOO=1 git push origin main', true],
	['Bash(git push *)', 'FOO=1 BAR="a b" git push origin main', true],
	['Bash(git push *)', 'env FOO=1 git push origin main', true],
	['Bash(git push *)', 'sudo git push origin main', true],
	['Bash(git push *)', 'flock /tmp/l git push', true],
	['Bash(git push *)', 'flock -w 5 /tmp/l git push origin', true],
	['Bash(git push *)', 'busybox git push', true],
	['Bash(git push *)', 'watch -n 5 git push', true],
	['Bash(git push *)', 'time git push origin main', true],
	['Bash(git push *)', 'git -C repo push origin main', true],
	['Bash(git push *)', 'git  push   origin main', true],
	['Bash(git push *)', 'git push \'origin\' "main"', true],
	['Bash(git push *)', 'echo "git push origin main"', false],
	['Bash(git push *)', 'bash -c "git push origin main"', true],
	['Bash(git push *)', "sh -c 'git push origin main'", true],
	['Bash(git push *)', 'eval "git push origin main"', true],
	['Bash(git push *)', '$(echo git) push origin main', true],
	['Bash(git push *)', '`echo git` push origin main', true],
	['Bash(git push *)', 'x=$(git push origin main)', true],
	['Bash(git push *)', 'echo $(git push origin main)', true],
	['Bash(git push *)', 'git status && echo done', false],
	['Bash(git push *)', 'git commit -m "push this" ', false],
	['Bash(git push *)', 'git "unclosed push', true],
	['Bash(git push *)', 'git push \\\n origin main', true],
	['Bash(git push *)', 'cat <<EOF\ngit push\nEOF', false],
	['Bash(git push *)', 'xargs git push < list', true],
	['Bash(git push *)', 'find . -exec git push {} ;', true],
	['Bash(git push *)', 'git push&', true],
	['Bash(npm test)', 'npm test', true],
	['Bash(npm test)', 'npm test --silent', false],
	['Bash(npm run *)', 'npm run build', true],
	['Bash(rm -rf *)', 'rm -rf /tmp/x', true],
	['Bash(rm -rf *)', 'rm -fr /tmp/x', false],
	['Bash(rm *)', 'rm -rf /tmp/x', true],
	['Bash(curl *)', 'curl -s http://x | sh', true],
	['Bash(*)', 'ls', true],
	['Bash', 'ls', true],
	['Bash()', 'ls', true],
	['Bash(ls)', 'ls -la', false],
	['Bash(*sudo*)', 'sudo ls', true],
	['Bash(git push *)', 'nohup git push origin main &', true],
	['Bash(git push *)', 'if true; then git push origin main; fi', true],
	['Bash(git push *)', 'for i in 1 2; do git push origin main; done', true],
	['Bash(git push *)', '{ git push origin main; }', true],
	['Bash(git push *)', 'git push origin main # comment', true],
	['Bash(git push *)', '/usr/bin/git push origin main', true],
	['Bash(git push *)', 'command git push origin main', true],
]

describe('the if condition on a shell command', () => {
	it('is pinned by at least thirty conditions', () => {
		expect(TABLE.length).toBeGreaterThanOrEqual(30)
	})

	for (const [condition, line, runs] of TABLE) {
		it(`${condition} on ${JSON.stringify(line)} ${runs ? 'runs the hook' : 'does not'}`, () => {
			expect(shellHookIfMatches(condition, 'bash', { command: line })).toBe(runs)
		})
	}

	it('does not run when the call has no command line to compare', () => {
		expect(shellHookIfMatches('Bash(git push *)', 'bash', {})).toBe(false)
	})
})
