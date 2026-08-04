import { ToolRegistry } from '@namzu/sdk'
import type { RunAgentOptions } from '@namzu/sdk'

import type { DeriveRunOptionsInput, ProjectManifest } from './types.js'

/**
 * Turn a loaded project into the options `runAgent` takes.
 *
 * One direction, no second engine. Everything this produces is an ordinary
 * `RunAgentOptions` field, so a caller who needs something this does not cover
 * spreads `overrides` or stops using this function — there is no behaviour
 * reachable only through the convention.
 */
export function deriveRunOptions(
	manifest: ProjectManifest,
	input: DeriveRunOptionsInput,
): RunAgentOptions {
	if (manifest.modules === 'skip') {
		// The manifest is structurally complete and its tools were never
		// imported, so `manifest.tools` is empty for a reason that has nothing
		// to do with the project. Running it would produce an agent with no
		// capabilities and no indication why.
		throw new Error(
			'This manifest was loaded with modules: "skip", so no tool was imported and none can be registered. Load with modules: "evaluate" before deriving run options.',
		)
	}

	const model = input.model ?? manifest.config.model
	if (!model) {
		throw new Error(
			`No model. Declare one in ${manifest.root}/agent.ts as \`export default { model: "…" }\`, or pass \`model\` here.`,
		)
	}

	const tools = new ToolRegistry()
	for (const entry of manifest.tools) tools.register(entry.definition)

	return {
		provider: input.provider,
		prompt: input.prompt,
		model,
		tools,
		// The one value the project knows and `runAgent` cannot infer. Left
		// unset it would default to the host's own cwd, pointing the file
		// tools' containment at the host's source tree rather than at the
		// project. The root is `agent/` itself, not its parent — narrower is
		// the safe direction, and widening it is the caller's explicit call
		// through `overrides`.
		workingDirectory: manifest.root,
		...(manifest.instructions ? { instructions: manifest.instructions } : {}),
		...(manifest.skills.length > 0 ? { skills: manifest.skills.map((s) => s.skill) } : {}),
		// Only when declared. A name guessed from a directory basename becomes
		// the agent id in traces, where two sibling projects called `agent`
		// would silently merge into one attribution bucket — worse than the
		// SDK's own default, which at least does not pretend to be specific.
		...(manifest.config.name ? { name: manifest.config.name } : {}),
		...(manifest.config.temperature !== undefined
			? { temperature: manifest.config.temperature }
			: {}),
		...(manifest.config.maxIterations !== undefined
			? { maxIterations: manifest.config.maxIterations }
			: {}),
		...(manifest.config.tokenBudget !== undefined
			? { tokenBudget: manifest.config.tokenBudget }
			: {}),
		...(manifest.config.timeoutMs !== undefined ? { timeoutMs: manifest.config.timeoutMs } : {}),
		...(input.identity ?? {}),
		...(input.overrides ?? {}),
	}
}
