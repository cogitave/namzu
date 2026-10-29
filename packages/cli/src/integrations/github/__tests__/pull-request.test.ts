import { describe, expect, it } from 'vitest'

import {
	commandChangesPullRequest,
	matchesPullRequestFilter,
	parsePullRequestFilter,
	parsePullRequestLink,
	pullRequestLabel,
	pullRequestOfRecords,
	pullRequestOfShellCall,
	pullRequestRef,
} from '../pull-request.js'

const GITHUB = 'https://github.com/acme/widgets/pull/42'

describe('the pull request an output names', () => {
	it('reads a GitHub address', () => {
		expect(parsePullRequestLink(`Creating pull request\n${GITHUB}\n`)).toEqual({
			number: 42,
			url: GITHUB,
			repository: 'acme/widgets',
		})
	})

	it('reads a GitLab merge request in a nested group', () => {
		expect(
			parsePullRequestLink('https://gitlab.example.com/group/sub/app/-/merge_requests/7'),
		).toEqual({
			number: 7,
			url: 'https://gitlab.example.com/group/sub/app/-/merge_requests/7',
			repository: 'group/sub/app',
		})
	})

	it('takes the last address when a command prints several', () => {
		const out = `see https://github.com/acme/widgets/pull/1\n${GITHUB}`
		expect(parsePullRequestLink(out)?.number).toBe(42)
	})

	it('finds nothing in text with no pull request address', () => {
		expect(parsePullRequestLink('https://github.com/acme/widgets/issues/42')).toBeNull()
		expect(parsePullRequestLink('done')).toBeNull()
	})
})

describe('a command that changes a pull request', () => {
	it.each([
		'gh pr create --title "x" --body "y"',
		'git push && gh pr create --fill',
		'gh pr merge 42 --squash',
		'gh pr comment 42 --body "ok"',
		'glab mr create --fill',
		'glab mr note 7 -m hi',
	])('%s', (command) => {
		expect(commandChangesPullRequest(command)).toBe(true)
	})

	it.each([
		'gh pr view 42',
		'gh pr list',
		'gh pr checkout 42',
		'gh pr create --dry-run',
		'echo "gh pr create"',
		'git log --oneline',
	])('%s changes nothing', (command) => {
		expect(commandChangesPullRequest(command)).toBe(false)
	})
})

describe('a finished shell call', () => {
	const call = { command: 'gh pr create --fill', output: GITHUB, isError: false }

	it('links the pull request it opened', () => {
		expect(pullRequestOfShellCall(call)?.number).toBe(42)
	})

	it('links nothing when the call failed or printed no address', () => {
		expect(pullRequestOfShellCall({ ...call, isError: true })).toBeNull()
		expect(pullRequestOfShellCall({ ...call, output: 'no commits between main and x' })).toBeNull()
		expect(pullRequestOfShellCall({ ...call, command: undefined })).toBeNull()
	})

	it('links nothing for a command that only reads a pull request', () => {
		expect(pullRequestOfShellCall({ ...call, command: 'gh pr view 42 --json url' })).toBeNull()
	})
})

describe('--from-pr', () => {
	it('takes no value, a number, a #number or an address', () => {
		expect(parsePullRequestFilter(true)).toEqual({ kind: 'any' })
		expect(parsePullRequestFilter('  ')).toEqual({ kind: 'any' })
		expect(parsePullRequestFilter('42')).toEqual({ kind: 'number', number: 42 })
		expect(parsePullRequestFilter('#42')).toEqual({ kind: 'number', number: 42 })
		expect(parsePullRequestFilter(GITHUB)).toEqual({ kind: 'number', number: 42 })
	})

	it('refuses anything else in a plain sentence', () => {
		const out = parsePullRequestFilter('soon')
		expect(out).toMatchObject({ error: expect.stringContaining('pull request number or address') })
		expect(parsePullRequestFilter('0')).toHaveProperty('error')
	})

	it('matches a linked conversation by number', () => {
		const pr = { number: 42 }
		expect(matchesPullRequestFilter(pr, { kind: 'any' })).toBe(true)
		expect(matchesPullRequestFilter(pr, { kind: 'number', number: 42 })).toBe(true)
		expect(matchesPullRequestFilter(pr, { kind: 'number', number: 7 })).toBe(false)
		expect(matchesPullRequestFilter(undefined, { kind: 'any' })).toBe(false)
	})
})

describe('the link as a record', () => {
	const link = { number: 42, url: GITHUB, repository: 'acme/widgets' }

	it('files the address under the pull-request protocol', () => {
		expect(pullRequestRef(link)).toEqual({
			protocol: 'pull-request',
			kind: 'context',
			externalId: GITHUB,
		})
	})

	it('reads the latest link back from a log, ignoring other references', () => {
		const records = [
			{ type: 'session_updated', externalRefs: { add: [pullRequestRef(link)] } },
			{
				type: 'session_updated',
				externalRefs: { add: [{ protocol: 'acp', kind: 'session', externalId: 'abc' }] },
			},
			{
				type: 'session_updated',
				externalRefs: {
					add: [
						pullRequestRef({ ...link, number: 43, url: 'https://github.com/acme/widgets/pull/43' }),
					],
				},
			},
		] as never
		expect(pullRequestOfRecords(records)?.number).toBe(43)
		expect(pullRequestOfRecords([] as never)).toBeUndefined()
	})

	it('labels a row with repository and number', () => {
		expect(pullRequestLabel(link)).toBe('acme/widgets#42')
	})
})
