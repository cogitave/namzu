/**
 * `namzu github install`: write GitHub Actions workflows that run Namzu.
 * See docs/cli/github.md.
 */

import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import {
	WORKFLOW_IDS,
	type WorkflowId,
	repositoryRoot,
	workflowLabel,
	writeWorkflows,
} from '../integrations/github/workflows.js'
import { PROVIDER_REGISTRY } from '../integrations/providers/registry.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { CLI_VERSION } from '../version.js'
import type { CommandDef } from './types.js'

const HELP = `namzu github — run Namzu from GitHub Actions

Usage:
  namzu github install [--workflow mention|review]... [--provider <id>] [--model <id>]
                       [--secret <name>] [--budget <dollars>] [--force] [--dry-run]

Writes workflow files under .github/workflows in this repository:
  mention  Answer @namzu mentions in issues and pull request comments
  review   Review each new pull request

Both run "namzu exec" on the runner with the repository read-only and a
spend limit, and post the reply as a comment. Without --workflow both are
written. A file that already exists is kept unless you pass --force.
--provider takes the provider whose key the runner uses (default anthropic);
--secret names the repository secret that holds that key (default: the
provider's usual variable name); --budget is the dollar limit for one run
(default 1). --dry-run prints what would be written and writes nothing.\n`

export interface InstallRequest {
	readonly workflows: readonly WorkflowId[]
	readonly provider: string
	readonly model: string | undefined
	readonly secret: string | undefined
	readonly budgetUsd: number
	readonly force: boolean
	readonly dryRun: boolean
}

export function parseInstallArgs(
	args: readonly string[],
): InstallRequest | { readonly error: string } {
	const workflows: WorkflowId[] = []
	let provider = 'anthropic'
	let model: string | undefined
	let secret: string | undefined
	let budgetUsd = 1
	let force = false
	let dryRun = false
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string
		const [flag, inline] =
			arg.startsWith('--') && arg.includes('=') ? splitOnce(arg) : [arg, undefined]
		const value = (): string | { readonly error: string } => {
			if (inline !== undefined) return inline
			const next = args[i + 1]
			if (next === undefined || next.startsWith('--')) return { error: `${flag} needs a value` }
			i++
			return next
		}
		if (flag === '--force') force = true
		else if (flag === '--dry-run') dryRun = true
		else if (
			flag === '--workflow' ||
			flag === '--provider' ||
			flag === '--model' ||
			flag === '--secret' ||
			flag === '--budget'
		) {
			const v = value()
			if (typeof v !== 'string') return v
			if (flag === '--workflow') {
				const id = WORKFLOW_IDS.find((entry) => entry === v)
				if (!id) return { error: `--workflow takes ${WORKFLOW_IDS.join(' or ')}, got ${v}` }
				if (!workflows.includes(id)) workflows.push(id)
			} else if (flag === '--provider') provider = v
			else if (flag === '--model') model = v
			else if (flag === '--secret') secret = v
			else {
				const n = Number(v)
				if (!v.trim() || !Number.isFinite(n) || n <= 0)
					return { error: `--budget takes a number of dollars greater than 0, got ${v}` }
				budgetUsd = n
			}
		} else return { error: `unknown option ${arg}` }
	}
	return {
		workflows: workflows.length > 0 ? workflows : [...WORKFLOW_IDS],
		provider,
		model,
		secret,
		budgetUsd,
		force,
		dryRun,
	}
}

function splitOnce(arg: string): [string, string] {
	const at = arg.indexOf('=')
	return [arg.slice(0, at), arg.slice(at + 1)]
}

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/

export const githubCommand: CommandDef = {
	name: 'github',
	description:
		'Run Namzu from GitHub Actions: install workflows that answer mentions and review pull requests',
	passThrough: true,
	help: HELP,
	handler: async ({ ctx, rawArgs }) => {
		const [verb, ...rest] = rawArgs
		if (verb !== 'install') {
			ctx.formatter.error({ message: HELP })
			return EXIT_USAGE
		}
		const request = parseInstallArgs(rest)
		if ('error' in request) {
			ctx.formatter.error({ message: `${request.error}\n\n${HELP}` })
			return EXIT_USAGE
		}
		const entry = (
			PROVIDER_REGISTRY as Record<
				string,
				(typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]
			>
		)[request.provider]
		const envVar = entry?.envVars[0]
		if (!entry || !envVar) {
			ctx.formatter.error({
				message: `${request.provider} has no API key a runner can read. Choose a provider that takes a key, such as anthropic, openai or google.`,
			})
			return EXIT_USAGE
		}
		const secret = request.secret ?? envVar
		if (!SECRET_NAME.test(secret)) {
			ctx.formatter.error({
				message: `${secret} is not a name GitHub accepts for a secret. Use letters, digits and underscores, starting with a letter or underscore.`,
			})
			return EXIT_USAGE
		}
		if (request.model !== undefined && !MODEL_ID.test(request.model)) {
			ctx.formatter.error({ message: `${request.model} is not a model name Namzu can pass on.` })
			return EXIT_USAGE
		}
		const root = repositoryRoot(process.cwd())
		if (root === null) {
			ctx.formatter.error({
				message:
					'This folder is not inside a Git repository, so there is nowhere to put the workflows.',
			})
			return EXIT_USAGE
		}
		const choices = {
			secret,
			envVar,
			provider: request.provider,
			...(request.model !== undefined ? { model: request.model } : {}),
			budgetUsd: request.budgetUsd,
			cliMajor: CLI_VERSION.split('.')[0] ?? CLI_VERSION,
		}
		if (request.dryRun) {
			const planned = request.workflows.map((id) => ({
				id,
				path: `.github/workflows/${id === 'mention' ? 'namzu.yml' : 'namzu-review.yml'}`,
			}))
			ctx.formatter.print({
				root,
				dryRun: true,
				workflows: planned,
				text: terminalDisplayText(
					`Would write, in ${root}:\n${planned.map((p) => `  ${p.path}  ${workflowLabel(p.id)}`).join('\n')}`,
				),
			})
			return EXIT_OK
		}
		const written = writeWorkflows(root, request.workflows, choices, request.force)
		const lines = written.map((item) =>
			item.status === 'kept'
				? `  ${item.path}  already exists, kept (--force replaces it)`
				: `  ${item.path}  ${item.status}`,
		)
		const changed = written.some((item) => item.status !== 'kept')
		const next = changed
			? [
					'',
					'Next:',
					`  1. Save your ${entry.label} key as the repository secret ${secret}:  gh secret set ${secret}`,
					'  2. Commit the workflow files and open a pull request.',
				]
			: []
		ctx.formatter.print({
			root,
			workflows: written,
			secret,
			text: terminalDisplayText(
				`Workflows in ${root}:\n${lines.join('\n')}${next.length ? `\n${next.join('\n')}` : ''}`,
			),
		})
		return EXIT_OK
	},
}
