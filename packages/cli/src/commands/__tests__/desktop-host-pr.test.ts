import { expect, it } from 'vitest'
import type { RunCommand } from '../../tui/pr-status.js'
import { projectPr } from '../desktop-host-pr.js'

/** A stand-in for git and gh: the branch it is on and what `gh pr view` answers or fails with. */
function stub(options: { branch?: string; gh?: string | { code?: string; stderr?: string } }) {
	const run: RunCommand = async (file, args) => {
		if (file === 'git' && args[1] === '--short' && args[2] === 'HEAD') {
			if (options.branch === undefined) throw Object.assign(new Error('not a repo'), { code: 128 })
			return { stdout: `${options.branch}\n` }
		}
		if (file === 'git') throw new Error('no origin HEAD')
		if (typeof options.gh === 'string') return { stdout: options.gh }
		throw Object.assign(new Error('gh failed'), options.gh ?? {})
	}
	return run
}
const view = (extra: Record<string, unknown>) =>
	JSON.stringify({ number: 607, url: 'https://github.com/o/r/pull/607', state: 'OPEN', ...extra })

it('gives the number, link and review state of an open pull request', async () => {
	expect(
		await projectPr('/p', stub({ branch: 'feat/x', gh: view({ reviewDecision: 'APPROVED' }) })),
	).toEqual({ number: 607, url: 'https://github.com/o/r/pull/607', review: 'approved' })
	expect(
		(
			await projectPr(
				'/p',
				stub({ branch: 'feat/x', gh: view({ reviewDecision: 'CHANGES_REQUESTED' }) }),
			)
		)?.review,
	).toBe('changes')
	expect((await projectPr('/p', stub({ branch: 'feat/x', gh: view({}) })))?.review).toBe('pending')
	expect(
		(await projectPr('/p', stub({ branch: 'feat/x', gh: view({ isDraft: true }) })))?.review,
	).toBe('draft')
})

it('stays silent when gh is missing, signed out, there is no pull request, or it is not a repository', async () => {
	expect(await projectPr('/p', stub({ branch: 'feat/x', gh: { code: 'ENOENT' } }))).toBeNull()
	expect(
		await projectPr(
			'/p',
			stub({
				branch: 'feat/x',
				gh: { stderr: 'To get started with GitHub CLI, please run: gh auth login' },
			}),
		),
	).toBeNull()
	expect(
		await projectPr(
			'/p',
			stub({ branch: 'feat/x', gh: { stderr: 'no pull requests found for branch' } }),
		),
	).toBeNull()
	expect(await projectPr('/p', stub({}))).toBeNull()
	// The default branch never has "its" pull request.
	expect(await projectPr('/p', stub({ branch: 'main', gh: view({}) }))).toBeNull()
})
