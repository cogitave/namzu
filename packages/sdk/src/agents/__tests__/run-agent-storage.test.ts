import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MockLLMProvider } from '../../provider/mock.js'
import { SessionPaths, slugForCwd } from '../../session/paths.js'
import { DiskSessionLog, InMemorySessionLog } from '../../store/session-log/index.js'
import { testToolset } from '../../test-support/toolset.js'
import { getBuiltinTools } from '../../tools/builtins/index.js'
import { generateSessionId } from '../../utils/id.js'
import { runAgent } from '../runAgent.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each([false, true])(
	'keeps session state outside the tool workspace (in memory: %s)',
	async (memory) => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-entry-storage-'))
		roots.push(root)
		const cwd = join(root, 'workspace')
		await mkdir(cwd)
		await writeFile(join(cwd, 'note.txt'), 'Current source.')
		const tools = testToolset(...getBuiltinTools().filter((t) => t.name === 'read'))
		const home = join(root, 'home')
		const paths = new SessionPaths({ home, slug: slugForCwd(await realpath(cwd)) })
		const sessionId = generateSessionId()
		const sessionLog = memory ? new InMemorySessionLog({ sessionId }) : undefined
		const result = await runAgent({
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] },
					{ text: 'Read the current source.' },
				],
			}),
			model: 'mock-model',
			prompt: 'Read note.txt',
			workingDirectory: cwd,
			toolsets: [tools],
			sessionId,
			...(memory ? { sessionLog } : { paths }),
		})
		expect(result.output).toBe('Read the current source.')
		expect(JSON.stringify(result.turn.messages)).toContain('Current source.')
		expect(await readdir(cwd)).toEqual(['note.txt'])
		// The conversation is the session log, read back through its fold.
		const log = sessionLog ?? DiskSessionLog.at(paths, { sessionId })
		expect(JSON.stringify(await log.messages())).toContain('Current source.')
		if (memory) {
			expect(await readdir(root)).toEqual(['workspace'])
		}
	},
)
