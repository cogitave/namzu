/**
 * The words a person reads before an install: what the plugin brings, and
 * above all what it runs. Every runnable kind in the surface has a line here;
 * a kind that is empty says nothing, and a kind that is not empty is never cut
 * off (a long list of scripts is counted and the first of them shown, with the
 * full list one `--json` away).
 *
 * Text that came from the plugin passes through `terminalDisplayText`, so a
 * name or a command cannot move the cursor or reorder the prompt.
 */

import { terminalDisplayText } from '../../tui/terminal-display.js'
import type { InstallPlan } from './install-plan.js'
import type { PluginSurface } from './surface.js'

const one = (value: string): string => terminalDisplayText(value).replace(/[\t\n\r]+/g, ' ')

const SCRIPTS_SHOWN = 12

function list(items: readonly string[]): string {
	return items.map(one).join(', ')
}

function bytes(count: number): string {
	return count < 1024 ? `${count} B` : `${(count / 1024).toFixed(1)} KB`
}

/** The lines that say what runs on this computer. Empty when nothing does. */
export function runsLines(surface: PluginSurface): string[] {
	const lines: string[] = []
	for (const hook of surface.hooks)
		lines.push(
			`    hook      ${one(hook.event)}${hook.matcher !== undefined ? ` ${one(hook.matcher)}` : ''}  ->  ${hook.type === 'command' ? '' : `${hook.type}: `}${one(hook.run)}`,
		)
	for (const hook of surface.fileHooks)
		lines.push(
			`    hook      ${one(hook.event)} in ${hook.kind} ${one(hook.name)}  ->  ${hook.type === 'command' ? '' : `${hook.type}: `}${one(hook.run)}`,
		)
	for (const server of surface.mcpLocal)
		lines.push(
			`    server    ${one(server.name)}  ->  ${one([server.command, ...server.args].join(' '))}${
				Object.keys(server.env).length > 0
					? `   (environment: ${list(Object.keys(server.env))})`
					: ''
			}`,
		)
	for (const server of surface.mcpRemote)
		lines.push(
			`    server    ${one(server.name)}  ->  ${one(server.origin)}   (asks you before it connects${
				server.sendsEnv.length > 0
					? `; would send ${server.sendsEnv.map((name) => `$${one(name)}`).join(', ')}`
					: ''
			}${server.headers.length > 0 ? `; headers: ${list(server.headers)}` : ''})`,
		)
	for (const module of surface.modules)
		lines.push(
			`    module    ${one(module.path)}  (JavaScript that runs inside the session${
				module.declares !== undefined && module.declares.length > 0
					? `; declares ${list(module.declares)}`
					: '; what it declares is not read before it runs'
			})`,
		)
	for (const script of surface.scripts.slice(0, SCRIPTS_SHOWN))
		lines.push(
			`    script    ${one(script.path)}  (${bytes(script.bytes)}${script.exec ? ', executable' : ''})`,
		)
	if (surface.scripts.length > SCRIPTS_SHOWN)
		lines.push(
			`    script    and ${surface.scripts.length - SCRIPTS_SHOWN} more (all of them in --json)`,
		)
	return lines
}

export interface PreviewOptions {
	/** `scope: user (every folder on this computer)`. */
	readonly scopeLine: string
	/** Lines to put under the heading, e.g. what an update changes. */
	readonly changes?: readonly string[]
	readonly headline?: string
}

/** The whole preview, ending with the digest `--accept-surface` takes. */
export function renderInstallPreview(plan: InstallPlan, options: PreviewOptions): string {
	const lines: string[] = [
		options.headline ??
			`Install ${one(plan.name)} ${one(plan.version)} from ${one(plan.marketplace)}?   ${options.scopeLine}`,
		'',
	]
	if (options.changes !== undefined && options.changes.length > 0) {
		lines.push('  What changed since the version you have:')
		for (const change of options.changes) lines.push(`    ${one(change)}`)
		lines.push('')
	}
	const { inventory, surface } = plan
	if (inventory.skills.length > 0)
		lines.push(`  Skills (${inventory.skills.length}):   ${list(inventory.skills)}`)
	if (inventory.commands.length > 0)
		lines.push(
			`  Commands (${inventory.commands.length}): ${inventory.commands.map((name) => `/${one(name)}`).join(', ')}`,
		)
	if (inventory.agents.length > 0)
		lines.push(`  Agents (${inventory.agents.length}):   ${list(inventory.agents)}`)
	const runs = runsLines(surface)
	lines.push(
		runs.length > 0 ? '  Runs on this computer:' : '  Runs on this computer: nothing found.',
	)
	lines.push(...runs)
	if (surface.unpinnedDownload) lines.push('    This download is not pinned to a digest.')
	for (const tools of surface.allowedTools)
		lines.push(`  Pre-approves tools: ${tools.kind} ${one(tools.name)} allows ${list(tools.tools)}`)
	const notUsed = plan.findings.filter((f) => f.level === 'notUsed')
	if (notUsed.length > 0)
		lines.push(
			`  Not used by Namzu: ${[...new Set(notUsed.map((f) => f.field ?? f.code))].map(one).join(', ')}`,
		)
	for (const finding of plan.findings.filter((f) => f.level === 'refused'))
		lines.push(`  Left out: ${one(finding.message)}`)
	for (const warning of plan.warnings) lines.push(`  Note: ${one(warning)}`)
	lines.push(
		'',
		'This plugin runs programs on your computer with your permissions. Namzu cannot',
		'check what they do. Install only plugins you trust.',
		`Surface: sha256:${plan.digest}`,
	)
	return lines.join('\n')
}
