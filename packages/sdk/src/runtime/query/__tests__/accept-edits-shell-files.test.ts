/**
 * `accept-edits` approves the shell commands that only make, touch, remove,
 * move, copy or edit files, when every path they name is inside the roots, and
 * the host says what the roots are. Nothing else about the mode changes: a
 * catastrophic removal, a path outside, a protected name, a path in a variable
 * and any other program still ask.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { testToolset } from '../../../test-support/toolset.js'
import { forgetCarriedDirectories, recordDirectory } from '../../../tools/builtins/bash-cwd.js'
import { BashTool } from '../../../tools/builtins/bash.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { HITLDecisionRequest, ToolCallSummary } from '../../../types/hitl/index.js'
import type { CheckpointId, TurnId } from '../../../types/ids/index.js'
import { generateSessionId } from '../../../utils/id.js'
import { createReviewHandler } from '../review-policy.js'

const SESSION_ID = generateSessionId()
const base = mkdtempSync(join(tmpdir(), 'namzu-accept-edits-'))
const project = join(base, 'project')
mkdirSync(join(project, 'src'), { recursive: true })
afterAll(() => rmSync(base, { recursive: true, force: true }))

const registry = new ToolManager({ toolsets: [testToolset(BashTool)], messages: () => [] })

let sequence = 0
const bash = (command: string, extra: Partial<ToolCallSummary> = {}): ToolCallSummary => {
	sequence += 1
	return {
		id: `call_${sequence}`,
		name: 'bash',
		input: { command },
		isDestructive: false,
		authorization: { decision: 'review' },
		...extra,
	}
}

const review = (...toolCalls: ToolCallSummary[]): HITLDecisionRequest => ({
	sessionId: SESSION_ID,
	type: 'tool_review',
	turnId: 'f8223c92-2ebb-4961-8f5c-51dffd77693e' as TurnId,
	checkpointId: '82267e66-99cd-4ee0-8a15-b8108f6fce73' as CheckpointId,
	toolCalls,
})

/** Whether accept-edits asked a person about the line, with the project as its root. */
async function asks(command: string, extra: Partial<ToolCallSummary> = {}): Promise<boolean> {
	const prompt = vi.fn(async () => ({ kind: 'approve' as const }))
	await createReviewHandler({ mode: 'accept-edits', prompt, registry, roots: [project] })(
		review(bash(command, extra)),
	)
	return prompt.mock.calls.length > 0
}

describe('accept-edits and shell file commands', () => {
	it.each([
		'mkdir out',
		'mkdir -p out/a/b',
		'touch notes.txt',
		'rm notes.txt',
		'rmdir out',
		'mv a.txt b.txt',
		'cp src/a.ts src/b.ts',
		"sed -i 's/old/new/g' src/a.ts",
		"sed -i -e 's/old/new/' src/a.ts",
		'sed -n 5p src/a.ts',
		'mkdir -p out && touch out/a.txt && cp out/a.txt out/b.txt',
		'cd src && touch a.ts',
		`touch ${join(project, 'src', 'abs.ts')}`,
		'rm src/*.tmp',
		'cp -t out src/a.ts',
		'cp --target-directory=out src/a.ts',
		'touch -d "@0" a.txt',
		'touch --reference=src/a.ts a.txt',
	])('approves %s without asking', async (command) => {
		expect(await asks(command)).toBe(false)
	})

	it.each([
		['a path outside the roots', 'touch /etc/namzu-test'],
		['a source outside the roots', 'cp /etc/hosts hosts.txt'],
		['a destination outside the roots', 'mv a.txt ../elsewhere/a.txt'],
		['a path that climbs out', 'rm ../../x'],
		['a cd that leaves the roots', 'cd .. && touch a.txt'],
		['a catastrophic removal', 'rm -rf ~'],
		['a removal of the working directory', 'rm -rf .'],
		['a removal a variable may widen', 'rm -rf "$DIR/"'],
		['a protected name', 'touch .git/hooks/pre-commit'],
		['a path in a variable', 'touch "$OUT"'],
		['a program that is not one of the seven', 'touch a.txt && git push'],
		['a command that reads, beside one that writes', 'touch a.txt | cat'],
		['a program nobody can name', '$CMD a.txt'],
		['sed with a command that runs a program', "sed -i 's/a/b/e' a.txt"],
		['sed with a command that writes a file', "sed -n 'w out.txt' a.txt"],
		['sed with a script from a file', 'sed -f script.sed a.txt'],
		['sed with a script it cannot read', 'sed -i "$SCRIPT" a.txt'],
		['a destination given with --target-directory=', 'cp a.txt b.txt --target-directory=/tmp'],
		['a moved file whose destination follows it', 'mv a.txt --target-directory=/tmp'],
		['a destination attached to -t', 'cp -t/tmp a.txt'],
		['a reference file outside the roots', 'touch a.txt --reference=/etc/passwd'],
		['a reference file attached to -r', 'touch -r/etc/passwd a.txt'],
		['a glob of every hidden entry', 'rm -rf .*'],
		['a line it cannot read to the end', 'touch a.txt && (echo'],
	])('still asks about %s', async (_what, command) => {
		expect(await asks(command)).toBe(true)
	})

	it('still asks about a call the kernel marked as escalated, whatever the line says', async () => {
		expect(await asks('touch a.txt', { escalation: { outsidePaths: ['/x'] } })).toBe(true)
		expect(await asks('touch a.txt', { escalation: { dangerousRemoval: 'rm ~' } })).toBe(true)
		expect(await asks('touch a.txt', { isDestructive: true })).toBe(true)
		expect(await asks('touch a.txt', { requiresApproval: true })).toBe(true)
		expect(
			await asks('touch a.txt', { authorization: { decision: 'review', explicitReview: true } }),
		).toBe(true)
	})

	it('asks when the host did not say what the roots are', async () => {
		const prompt = vi.fn(async () => ({ kind: 'approve' as const }))
		await createReviewHandler({ mode: 'accept-edits', prompt, registry })(review(bash('mkdir out')))
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('reads the roots when it decides, so a directory added mid-session counts', async () => {
		const added = join(base, 'added')
		mkdirSync(added)
		let roots: string[] = [project]
		const prompt = vi.fn(async () => ({ kind: 'approve' as const }))
		const decide = createReviewHandler({
			mode: 'accept-edits',
			prompt,
			registry,
			roots: () => roots,
		})
		await decide(review(bash(`touch ${join(added, 'a.txt')}`)))
		expect(prompt).toHaveBeenCalledTimes(1)
		roots = [project, added]
		await decide(review(bash(`touch ${join(added, 'a.txt')}`)))
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('asks about the whole batch when one call is not a file command', async () => {
		const prompt = vi.fn(async () => ({ kind: 'approve' as const }))
		await createReviewHandler({ mode: 'accept-edits', prompt, registry, roots: [project] })(
			review(bash('mkdir out'), bash('npm test')),
		)
		expect(prompt).toHaveBeenCalledTimes(1)
	})
})

describe('accept-edits resolves carried shell cwd', () => {
	it.skipIf(process.platform === 'win32')(
		'does not auto-approve a plain name inside carried .git/hooks',
		async () => {
			const cwd = join(project, '.git', 'hooks')
			mkdirSync(cwd, { recursive: true })
			const capture = join(project, 'capture')
			writeFileSync(capture, cwd)
			await recordDirectory(SESSION_ID, capture, { workingDirectory: project })
			try {
				expect(await asks('touch pre-commit')).toBe(true)
			} finally {
				forgetCarriedDirectories()
			}
		},
	)
})
