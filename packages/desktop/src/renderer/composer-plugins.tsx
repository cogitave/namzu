import { useEffect, useRef, useState } from 'react'
import { ComposerControl, ComposerControlChevron } from './composer-control.js'
import { LoaderCircleIcon, PuzzleIcon } from './icons.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'

export interface ComposerPlugin {
	readonly name: string
	readonly version: string
	readonly description: string
	readonly scope: 'project' | 'user'
	readonly status: string
	readonly startupEnabled?: boolean
	readonly startupError?: string
}
export interface ComposerPluginInventory {
	readonly plugins: readonly ComposerPlugin[]
	readonly live: boolean
	readonly canChange: boolean
	readonly notice?: string
}

/** Inventory is host owned; changes target the plugin runtime of this exact conversation. */
export function ComposerPlugins({
	scope,
	view,
	loading,
	disabled,
	onOpen,
	onSetEnabled,
}: {
	scope: string
	view?: ComposerPluginInventory
	loading: boolean
	disabled: boolean
	onOpen: () => void
	onSetEnabled: (plugin: ComposerPlugin, enabled: boolean) => Promise<void>
}) {
	const [open, setOpen] = useState(false)
	const [changing, setChanging] = useState<string>()
	const [error, setError] = useState<string>()
	const owner = useRef(scope)
	const generation = useRef(0)
	if (owner.current !== scope) {
		owner.current = scope
		generation.current++
	}
	const admission = useRef(false)
	useEffect(() => {
		owner.current = scope
		setOpen(false)
		setError(undefined)
		setChanging(undefined)
		admission.current = false
	}, [scope])
	const change = async (plugin: ComposerPlugin) => {
		if (disabled || !view?.live || !view.canChange || admission.current) return
		const target = scope
		const targetGeneration = generation.current
		admission.current = true
		setChanging(plugin.name)
		setError(undefined)
		try {
			await onSetEnabled(plugin, plugin.status !== 'enabled')
		} catch (error) {
			if (owner.current === target && generation.current === targetGeneration)
				setError(error instanceof Error ? error.message : String(error))
		} finally {
			if (owner.current === target && generation.current === targetGeneration) {
				admission.current = false
				setChanging(undefined)
			}
		}
	}
	return (
		<Popover
			open={open && !disabled}
			onOpenChange={(next) => {
				setOpen(next)
				if (next) {
					setError(undefined)
					onOpen()
				}
			}}
		>
			<PopoverTrigger
				render={<ComposerControl size="xs" disabled={disabled} aria-label="Plugins" />}
			>
				<PuzzleIcon className="size-3.5" />
				Plugins
				<ComposerControlChevron size="xs" />
			</PopoverTrigger>
			<PopoverPopup
				side="top"
				align="start"
				aria-label="Plugins"
				width="lg"
				padding="compact"
				className="max-h-[min(28rem,var(--available-height))] overflow-y-auto"
			>
				<h2 className="text-sm font-medium">Plugins</h2>
				{loading && (
					<p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
						<LoaderCircleIcon className="size-3.5 animate-spin" />
						Loading plugins…
					</p>
				)}
				{view?.notice && <p className="mt-2 text-xs text-muted-foreground">{view.notice}</p>}
				{view?.live && !view.canChange && (
					<p className="mt-2 text-xs text-muted-foreground">
						Finish the active work before changing plugins.
					</p>
				)}
				{error && (
					<p role="alert" className="mt-2 text-xs text-destructive">
						{error}
					</p>
				)}
				{view && view.plugins.length === 0 && !view.notice && !loading && (
					<p className="mt-2 text-xs text-muted-foreground">
						No plugins are loaded in this conversation.
					</p>
				)}
				<ul className="mt-3 space-y-2">
					{view?.plugins.map((plugin) => (
						<li
							key={`${plugin.scope}:${plugin.name}`}
							className="rounded-lg border border-border p-3"
						>
							<div className="flex items-center justify-between gap-3">
								<span className="min-w-0 truncate text-sm font-medium" title={plugin.name}>
									{plugin.name}
								</span>
								{view.live ? (
									<Button
										variant="ghost-muted"
										size="xs"
										disabled={
											!view.canChange ||
											Boolean(changing) ||
											!['enabled', 'disabled', 'installed'].includes(plugin.status)
										}
										onClick={() => {
											void change(plugin)
										}}
										aria-label={`${plugin.status === 'enabled' ? 'Disable' : 'Enable'} ${plugin.name}`}
									>
										{changing === plugin.name
											? 'Changing…'
											: plugin.status === 'enabled'
												? 'Disable'
												: 'Enable'}
									</Button>
								) : null}
							</div>
							<p className="mt-1 text-xs text-muted-foreground">
								{plugin.version && `${plugin.version} · `}
								{plugin.scope} ·{' '}
								{view.live
									? plugin.status
									: plugin.status === 'error'
										? 'Unavailable'
										: 'Installed'}
							</p>
							{plugin.description && (
								<p className="mt-1 text-xs text-muted-foreground">{plugin.description}</p>
							)}
							<p className="mt-1 text-xs text-muted-foreground">
								{plugin.startupEnabled === undefined
									? 'Saved setting unavailable'
									: plugin.startupEnabled
										? 'Starts enabled next time'
										: 'Starts disabled next time'}
							</p>
							{plugin.startupError && (
								<p className="mt-1 text-xs text-destructive">{plugin.startupError}</p>
							)}
						</li>
					))}
				</ul>
			</PopoverPopup>
		</Popover>
	)
}
