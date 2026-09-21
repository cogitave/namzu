/**
 * Narration is written by the parent and by nothing else.
 *
 * The guarantee is structural rather than textual: the tool that writes a
 * line is returned to the host for the PARENT's registry, and a child's
 * roster is the registry the host's own `buildTools()` builds, which carries
 * none of the delegation tools. So these take the definition the `Agent` tool
 * would spawn and read the tools its config actually carries — the same seam
 * the read-only explore test uses — rather than asserting the property from a
 * prompt or a comment.
 *
 * Why it matters: a line a child emitted and this host rendered above the
 * rail would be untrusted text presented as the turn's own voice, which is the
 * injection shape the coordinator's untrusted-output wrapping exists to
 * prevent.
 */

import {
	type AgentDefinition,
	AgentRegistry,
	MockLLMProvider,
	type SessionId,
	ToolRegistry,
	type TurnId,
	getBuiltinTools,
	isReviewExempt,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { subagentParentFixture } from '../__fixtures__/parent.js'
import { MAX_NARRATION_CODE_UNITS, MAX_RETAINED_NARRATION } from '../activity.js'
import {
	EXPLORE_SUBAGENT,
	GENERAL_PURPOSE_SUBAGENT,
	type SubagentRuntime,
	createSubagentRuntime,
} from '../runtime.js'

afterEach(() => {
	vi.restoreAllMocks()
})

function toolContext({ sessionId, turnId }: { sessionId: SessionId; turnId: TurnId }) {
	return {
		sessionId,
		turnId,
		workingDirectory: process.cwd(),
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	}
}

/** The runtime keeps its agent registry private; capture what it registers. */
async function runtimeWithBuiltins(): Promise<{
	runtime: SubagentRuntime
	registered: AgentDefinition[]
	scope: { sessionId: SessionId; turnId: TurnId }
}> {
	const registered: AgentDefinition[] = []
	vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation(function (
		this: AgentRegistry,
		definition,
	) {
		for (const one of Array.isArray(definition) ? definition : [definition]) registered.push(one)
	})
	const parent = await subagentParentFixture(process.cwd())
	const runtime = await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		cwd: process.cwd(),
		model: 'test-model',
		// A mock with no turns is one that is never asked anything: these read
		// rosters and tool results, and start no child.
		buildProvider: () => new MockLLMProvider({ turns: [] }),
		buildTools: () => {
			const tools = new ToolRegistry()
			tools.register(getBuiltinTools())
			return tools
		},
	})
	return { runtime, registered, scope: parent.scope }
}

async function childToolNames(
	registered: readonly AgentDefinition[],
	id: string,
): Promise<string[]> {
	const definition = registered.find((entry) => entry.info.id === id)
	if (!definition?.configBuilder) throw new Error(`no definition registered for ${id}`)
	const config = (await definition.configBuilder({})) as unknown as {
		tools: { listNames(): string[] }
	}
	return config.tools.listNames()
}

describe('narration', () => {
	it('records one line the operator can read, and nothing else', async () => {
		const { runtime, scope } = await runtimeWithBuiltins()
		try {
			const result = await runtime.narrationTool.execute(
				{ line: 'map returned five lenses; one changes the sequencing' },
				toolContext(scope),
			)

			expect(result.success).toBe(true)
			expect(runtime.activity.getNarration?.()?.map((entry) => entry.text)).toEqual([
				'map returned five lenses; one changes the sequencing',
			])
			// Commentary is not a delegation: no child row appears beside it.
			expect(runtime.activity.getSnapshot()).toEqual([])
		} finally {
			await runtime.close()
		}
	})

	it('keeps the most recent lines and refuses a blank one', async () => {
		const { runtime, scope } = await runtimeWithBuiltins()
		try {
			for (let index = 1; index <= MAX_RETAINED_NARRATION + 1; index += 1)
				await runtime.narrationTool.execute({ line: `line ${index}` }, toolContext(scope))
			const blank = await runtime.narrationTool.execute({ line: '   ' }, toolContext(scope))

			expect(blank.success).toBe(false)
			expect(blank.error).toContain('blank')
			expect(runtime.activity.getNarration?.()?.map((entry) => entry.text)).toEqual([
				'line 2',
				'line 3',
				'line 4',
			])
		} finally {
			await runtime.close()
		}
	})

	it('clips a line that overruns the row, and refuses text that is not a line at all', async () => {
		const { runtime, scope } = await runtimeWithBuiltins()
		try {
			const schema = runtime.narrationTool.inputSchema
			expect(schema.safeParse({ line: 'a'.repeat(MAX_NARRATION_CODE_UNITS) }).success).toBe(true)
			// A modest overrun is accepted and clipped rather than rejected: the
			// answer an operator wants is the sentence with a marker, not an
			// error about a character count.
			expect(schema.safeParse({ line: 'a'.repeat(MAX_NARRATION_CODE_UNITS + 1) }).success).toBe(
				true,
			)
			// A paragraph is not a line. Refused by the schema rather than
			// silently reduced to its opening clause.
			expect(schema.safeParse({ line: 'a'.repeat(MAX_NARRATION_CODE_UNITS * 2 + 1) }).success).toBe(
				false,
			)
			expect(schema.safeParse({}).success).toBe(false)

			// The clip is reachable through the tool, not only through the
			// monitor: what the operator sees carries the marker.
			const clipped = await runtime.narrationTool.execute(
				{ line: `verifying ${'x'.repeat(MAX_NARRATION_CODE_UNITS)}` },
				toolContext(scope),
			)
			expect(clipped.success).toBe(true)
			const shown = runtime.activity.getNarration?.()?.at(-1)?.text ?? ''
			expect(shown.length).toBeLessThanOrEqual(MAX_NARRATION_CODE_UNITS)
			expect(shown).toContain('[clipped]')
		} finally {
			await runtime.close()
		}
	})

	it('says the session stopped showing lines rather than calling a good line blank', async () => {
		const { runtime, scope } = await runtimeWithBuiltins()
		await runtime.close()

		const afterClose = await runtime.narrationTool.execute(
			{ line: 'the last phase came back clean' },
			toolContext(scope),
		)

		expect(afterClose.success).toBe(false)
		// The two refusals are different facts. Reporting a closed session as a
		// blank line sends the writer to fix text that was never the problem.
		expect(afterClose.error).not.toContain('blank')
		expect(afterClose.error).toContain('narration')
	})

	it('shows its line without stopping to ask the operator for permission', async () => {
		const { runtime } = await runtimeWithBuiltins()
		try {
			const registry = new ToolRegistry()
			registry.register(runtime.narrationTool)
			registry.register(runtime.sendMessageTool)

			// The same predicate the TUI's prompt consults. A consent dialog per
			// line of commentary — shown to the very operator being asked — is a
			// tool nobody would call, so the line must run like a read.
			expect(isReviewExempt(registry, runtime.narrationTool.name, { line: 'a' })).toBe(true)
			// Its neighbour still asks: that one reaches into a running child.
			expect(isReviewExempt(registry, 'send_message', {})).toBe(false)
		} finally {
			await runtime.close()
		}
	})

	it('is not on any child roster, so no child can write the turn a line', async () => {
		const { runtime, registered } = await runtimeWithBuiltins()
		try {
			for (const id of [GENERAL_PURPOSE_SUBAGENT, EXPLORE_SUBAGENT]) {
				const names = await childToolNames(registered, id)
				expect(names, `${id} must not be able to narrate`).not.toContain(runtime.narrationTool.name)
				// The neighbouring parent-only tools are absent for the same
				// reason; narration is not a new kind of boundary.
				expect(names).not.toContain('send_message')
			}
		} finally {
			await runtime.close()
		}
	})
})
