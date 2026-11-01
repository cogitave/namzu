import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { editableCopyPath } from '../resume.js'
import { workflowHarness } from './harness.js'

const META = "export const meta = { name: 'Audit run', description: 'Three steps' }\n"
const THREE = `${META}return [await agent('one'), await agent('two'), await agent('three')]`

describe('resuming a workflow through the tool', () => {
	const open: Awaited<ReturnType<typeof workflowHarness>>[] = []
	afterEach(async () => {
		for (const h of open.splice(0)) {
			await h.close()
			removeTempDir(h.cwd)
		}
	})
	const make = async (options?: Parameters<typeof workflowHarness>[0]) => {
		const h = await workflowHarness(options)
		open.push(h)
		return h
	}
	const idOf = (result: { data?: unknown }) => (result.data as { run_id: string }).run_id

	it('names the editable copy and how to resume in the receipt, and writes the copy privately', async () => {
		const h = await make()
		const result = await h.start({ script: THREE })
		const runId = idOf(result)
		const path = editableCopyPath(h.runs, 'Audit run', runId)
		expect(path).toContain('audit-run-')
		expect(result.output).toContain(`Script file: ${path}`)
		expect(result.output).toContain(`Run ID: ${runId}`)
		expect(result.output).toContain(`resumeFromRunId: "${runId}"`)
		expect(readFileSync(path, 'utf8')).toBe(THREE)
		expect(statSync(path).mode & 0o777).toBe(0o600)
		await h.untilEnded()
	})

	it('returns every saved result of an unchanged script without starting an agent, under the same run id', async () => {
		const h = await make()
		const first = await h.start({ script: THREE })
		const runId = idOf(first)
		await h.untilEnded()
		const path = editableCopyPath(h.runs, 'Audit run', runId)
		expect(h.prompts).toHaveLength(3)

		const second = await h.start({ scriptPath: path, resumeFromRunId: runId })
		expect(second.success).toBe(true)
		expect(idOf(second)).toBe(runId)
		await h.untilEnded(2)
		expect(h.prompts).toHaveLength(3)
		const end = h.ended[1]
		expect(end?.view.status).toBe('completed')
		expect(end?.view.pass).toBe(2)
		expect(end?.view.agents.every((agent) => agent.cached === true)).toBe(true)
		expect(end?.view.result).toEqual(['ok:one', 'ok:two', 'ok:three'])
		expect(end?.view.usage?.cachedAgents).toBe(3)
		const journal = h.readJournal(runId)
		expect(journal.match(/"type":"run_started"/g)).toHaveLength(2)
		expect(readFileSync(join(h.runs, runId, 'workflow', 'script.2.js'), 'utf8')).toBe(THREE)
	})

	it('runs only the edited call and what follows when the saved script is edited', async () => {
		const h = await make()
		const runId = idOf(await h.start({ script: THREE }))
		await h.untilEnded()
		const path = editableCopyPath(h.runs, 'Audit run', runId)
		writeFileSync(path, THREE.replace("'two'", "'two, better'"))
		await h.start({ scriptPath: path, resumeFromRunId: runId })
		await h.untilEnded(2)
		expect(h.prompts.slice(3)).toEqual(['two, better', 'three'])
		expect(h.ended[1]?.view.result).toEqual(['ok:one', 'ok:two, better', 'ok:three'])
	})

	it('accepts the script inline when resuming, and refreshes the editable copy', async () => {
		const h = await make()
		const runId = idOf(await h.start({ script: THREE }))
		await h.untilEnded()
		const edited = THREE.replace("'three'", "'3'")
		await h.start({ script: edited, resumeFromRunId: runId })
		await h.untilEnded(2)
		expect(h.prompts.slice(3)).toEqual(['3'])
		expect(readFileSync(editableCopyPath(h.runs, 'Audit run', runId), 'utf8')).toBe(edited)
	})

	it('does not trust a signed journal line that was edited, even the last one', async () => {
		const h = await make({ journalKey: 'k'.repeat(40) })
		const runId = idOf(await h.start({ script: THREE }))
		await h.untilEnded()
		const file = join(h.runs, runId, 'workflow', 'journal.jsonl')
		const lines = readFileSync(file, 'utf8').split('\n')
		const at = lines.map((l) => l.includes('"result":"ok:three"')).lastIndexOf(true)
		lines[at] = (lines[at] as string).replace('"result":"ok:three"', '"result":"forged"')
		writeFileSync(file, lines.join('\n'))
		const second = await h.start({ script: THREE, resumeFromRunId: runId })
		expect(second.success).toBe(true)
		await h.untilEnded(2)
		expect(h.prompts.slice(3)).toEqual(['three'])
		expect(h.ended[1]?.view.result).toEqual(['ok:one', 'ok:two', 'ok:three'])
	})

	it('refuses to resume a run that is still going, and says what to do', async () => {
		const h = await make({ held: true })
		const runId = idOf(await h.start({ script: THREE }))
		await h.until(() => h.gate.waiting() === 1)
		const result = await h.start({ script: THREE, resumeFromRunId: runId })
		expect(result.success).toBe(false)
		expect(result.error).toContain(`Workflow ${runId} is still running. Stop it first`)
		h.host.registry.stop(runId)
		await h.untilEnded()
		const stopping = await h.start({ script: THREE, resumeFromRunId: runId })
		expect(stopping.success).toBe(true)
		h.gate.open()
		await h.untilEnded(2)
	})

	it('explains an unknown run, a malformed id and a journal written before resuming existed', async () => {
		const h = await make()
		const none = await h.start({ script: THREE, resumeFromRunId: 'wzzzzzzzz' })
		expect(none.error).toContain('There is no saved journal for workflow wzzzzzzzz')
		const bad = await h.start({ script: THREE, resumeFromRunId: 'nonsense' })
		expect(bad.error).toContain('is not a workflow run id')

		const runId = idOf(await h.start({ script: THREE }))
		await h.untilEnded()
		const file = join(h.runs, runId, 'workflow', 'journal.jsonl')
		const stripped = readFileSync(file, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const { seq: _s, prev: _p, mac: _m, key: _k, ...rest } = JSON.parse(line)
				return JSON.stringify(rest)
			})
		writeFileSync(file, `${stripped.join('\n')}\n`)
		const legacy = await h.start({ script: THREE, resumeFromRunId: runId })
		expect(legacy.success).toBe(false)
		expect(legacy.error).toContain('was saved before resuming was possible')
	})

	it('needs a script or a path, and rejects a control character', async () => {
		const h = await make()
		expect((await h.start({})).error).toBe(
			'Give the script text in `script`, or the path of a saved script in `scriptPath`.',
		)
		const escaped = await h.start({ script: `${THREE}\u001b[31m` })
		expect(escaped.error).toContain('control character')
		const lone = await h.start({ script: `${META}\rreturn 1` })
		expect(lone.error).toContain('control character')
		const crlf = await h.start({ script: `${META}\r\nreturn 1` })
		expect(crlf.error ?? '').not.toContain('control character')
	})

	it('only reads saved scripts: not a link, not another folder, not a network path', async () => {
		const h = await make()
		const runId = idOf(await h.start({ script: THREE }))
		await h.untilEnded()
		const path = editableCopyPath(h.runs, 'Audit run', runId)
		const outside = join(h.cwd, 'outside.js')
		writeFileSync(outside, THREE)
		expect((await h.start({ scriptPath: outside })).error).toContain('outside the folder')
		const link = path.replace('.js', '-link.js')
		symlinkSync(path, link)
		expect((await h.start({ scriptPath: link })).error).toContain('is not a regular file')
		expect((await h.start({ scriptPath: join(path, '..', 'missing.js') })).error).toContain(
			'was not found',
		)
		expect((await h.start({ scriptPath: '//server/share/x.js' })).error).toContain(
			'Network paths are not allowed',
		)
		const big = path.replace('.js', '-big.js')
		writeFileSync(big, 'x'.repeat(262_145))
		expect((await h.start({ scriptPath: big })).error).toContain('is larger than')
		expect(existsSync(path)).toBe(true)
	})

	it('a script given inline wins over scriptPath', async () => {
		const h = await make()
		const runId = idOf(await h.start({ script: THREE }))
		await h.untilEnded()
		const path = editableCopyPath(h.runs, 'Audit run', runId)
		writeFileSync(path, `${META}return 'from the file'`)
		const result = await h.start({ script: `${META}return 'inline'`, scriptPath: path })
		// It ends before asking for an agent, so the call answers with the return value.
		expect(result.output).toContain('inline')
		expect(result.output).not.toContain('from the file')
	})
})
