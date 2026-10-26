import { describe, expect, it } from 'vitest'
import { judgeExit } from '../exit-semantics.js'

describe('judgeExit', () => {
	it('never fails exit 0', () => {
		expect(judgeExit('grep x f', 0)).toEqual({ isError: false })
		expect(judgeExit('false', 0)).toEqual({ isError: false })
	})

	it.each([
		['grep foo src', 'No matches found'],
		['rg foo', 'No matches found'],
		['egrep -n a b', 'No matches found'],
		['fgrep a b', 'No matches found'],
		['find . -name x', 'Some directories were inaccessible'],
		['diff a b', 'Files differ'],
		['test -f x', 'Condition is false'],
		['[ -f x ]', 'Condition is false'],
		['git diff --quiet', 'Files differ'],
		['git grep foo', 'No matches found'],
		['git -C /tmp -c a=b diff', 'Files differ'],
	])('reads exit 1 of %s as an answer', (command, note) => {
		expect(judgeExit(command, 1)).toEqual({ isError: false, note })
	})

	it('fails exit 2 and above for those commands', () => {
		expect(judgeExit('grep foo missing', 2).isError).toBe(true)
		expect(judgeExit('diff a b', 3).isError).toBe(true)
		expect(judgeExit('rg x', 130).isError).toBe(true)
	})

	it('keeps the plain rule for every other command', () => {
		expect(judgeExit('npm test', 1)).toEqual({ isError: true })
		expect(judgeExit('git status', 1)).toEqual({ isError: true })
		expect(judgeExit('git commit -m x', 1)).toEqual({ isError: true })
		expect(judgeExit('FOO=1 grep x f', 1)).toEqual({ isError: true })
		expect(judgeExit('/usr/bin/grep x f', 1)).toEqual({ isError: true })
	})

	it('judges by the last command of the line', () => {
		expect(judgeExit('cat f | grep x', 1).isError).toBe(false)
		expect(judgeExit('grep x f | wc -l', 1).isError).toBe(true)
		expect(judgeExit('npm test; grep x f', 1).isError).toBe(false)
		expect(judgeExit('grep x f || true', 1).isError).toBe(true)
		expect(judgeExit('npm test || grep x f', 1).isError).toBe(false)
		expect(judgeExit('grep x f 2>&1', 1).isError).toBe(false)
		expect(judgeExit('grep "a && b" f', 1).isError).toBe(false)
		expect(judgeExit('grep "$(cat p)" f', 1).isError).toBe(false)
	})

	it('does not trust a status an earlier && step may have produced', () => {
		expect(judgeExit('cd missing && grep x f', 1).isError).toBe(true)
		expect(judgeExit('make && cat f | grep x', 1).isError).toBe(true)
		expect(judgeExit('a && b || grep x f', 1).isError).toBe(false)
		expect(judgeExit('cd d; grep x f', 1).isError).toBe(false)
	})

	it('keeps the plain rule for lines it cannot follow', () => {
		expect(judgeExit('(cd d && grep x f)', 1).isError).toBe(true)
		expect(judgeExit('grep "unclosed f', 1).isError).toBe(true)
		expect(judgeExit('cat <<EOF\nhi\nEOF\ngrep x f', 1).isError).toBe(true)
		expect(judgeExit(`grep ${'a'.repeat(10_001)}`, 1).isError).toBe(true)
		expect(judgeExit('', 1).isError).toBe(true)
	})
})
