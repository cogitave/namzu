import type { EngineDialect, LocalEngine } from './engine.js'

/**
 * The engines speak nearly the same command line. Every place they differ is
 * here, so the lifecycle in index.ts reads the same for all of them.
 */

export type PublishedPorts = Record<string, { HostIp?: string; HostPort?: string }[]>

/** Podman machines on WSL can lack delegated cgroup controllers. */
export function resourceFlags(dialect: EngineDialect): string[] {
	return dialect === 'podman' ? ['--cgroups=disabled'] : []
}

/**
 * The container boundary. wslc has no flag for any of these; its boundary is
 * the per-user virtual machine, the unprivileged guest user and the image.
 */
export function hardeningFlags(dialect: EngineDialect): string[] {
	if (dialect === 'wslc') return []
	return ['--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--ipc=private']
}

/** Command line that prints full container ids, one per line, for a filter. */
export function containerIdQuery(
	dialect: EngineDialect,
	filter: string,
	options: { readonly full: boolean },
): string[] {
	// wslc has no Go templates and truncates -q ids to 12 characters.
	if (dialect === 'wslc') return ['ps', '-a', '--filter', filter, '-q', '--no-trunc']
	return [
		'ps',
		'--all',
		'--filter',
		filter,
		...(options.full ? ['--no-trunc'] : []),
		'--format',
		'{{.ID}}',
	]
}

export function portsQuery(dialect: EngineDialect, name: string): string[] {
	if (dialect === 'wslc') return ['inspect', '-f', 'json', name]
	return ['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]
}

/** Read published ports from what `portsQuery` printed. */
export function parsePublishedPorts(dialect: EngineDialect, output: string): PublishedPorts {
	const parsed: unknown = JSON.parse(output)
	if (dialect !== 'wslc') return parsed as PublishedPorts
	const first = (Array.isArray(parsed) ? parsed[0] : undefined) as
		| { Ports?: PublishedPorts; NetworkSettings?: { Ports?: PublishedPorts } }
		| undefined
	return first?.Ports ?? first?.NetworkSettings?.Ports ?? {}
}

/** Make sure the labelled volume exists, creating it only when absent. */
export async function ensureVolume(
	engine: LocalEngine,
	dialect: EngineDialect,
	volume: string,
	label: string,
	signal?: AbortSignal,
): Promise<void> {
	if (dialect !== 'wslc') {
		await engine.run(
			['volume', 'create', ...(dialect === 'podman' ? ['--ignore'] : []), '--label', label, volume],
			{ signal },
		)
		return
	}
	// wslc has no --ignore. A missing volume is either a failed command or an
	// empty list, depending on how the output was captured.
	let present = false
	try {
		const found: unknown = JSON.parse(await engine.run(['volume', 'inspect', volume], { signal }))
		present = Array.isArray(found) && found.length > 0
	} catch {
		signal?.throwIfAborted()
	}
	if (!present) await engine.run(['volume', 'create', '--label', label, volume], { signal })
}
