import { useEffect, useRef, useState } from 'react'
import { ComposerControl, ComposerControlChevron } from './composer-control.js'
import { LoaderCircleIcon, PuzzleIcon } from './icons.js'
import { PluginActions } from './plugin-actions.js'
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
export interface ComposerPublicPlugin {
	readonly name: string
	readonly version: string
	readonly description: string
}
export type PluginCollection = 'public' | 'personal'
export interface PluginSelection {
	readonly collection: PluginCollection
	readonly name: string
	readonly scope?: ComposerPlugin['scope']
}
export interface ComposerPluginInventory {
	readonly plugins: readonly ComposerPlugin[]
	readonly publicPlugins?: readonly ComposerPublicPlugin[]
	readonly publicNotice?: string
	readonly live: boolean
	readonly canChange: boolean
	readonly notice?: string
}

export interface PluginInventoryProps {
	scope: string
	view?: ComposerPluginInventory
	loading: boolean
	disabled: boolean
	contextLabel?: string
	onSetEnabled: (plugin: ComposerPlugin, enabled: boolean) => Promise<void>
}

interface PluginMenuProps extends PluginInventoryProps {
	onOpen: () => void
}

/** Shared admission and ownership guards for the inventory page and composer menu. */
export function usePluginInventory({
	scope,
	view,
	loading,
	disabled,
	onSetEnabled,
}: PluginInventoryProps) {
	const [state, setState] = useState<{
		scope: string
		generation: number
		changing?: string
		error?: string
		errorPlugin?: string
	}>({ scope, generation: 0 })
	const owner = useRef({
		scope,
		generation: 0,
		admitted: false,
		mounted: true,
	})
	if (owner.current.scope !== scope) {
		owner.current.scope = scope
		owner.current.generation++
		owner.current.admitted = false
	}
	useEffect(() => {
		owner.current.mounted = true
		return () => {
			owner.current.mounted = false
			owner.current.generation++
		}
	}, [])
	const currentState = state.scope === scope && state.generation === owner.current.generation
	const changing = currentState ? state.changing : undefined
	const error = currentState ? state.error : undefined
	const errorPlugin = currentState ? state.errorPlugin : undefined
	const canChange = (plugin: ComposerPlugin) =>
		!disabled &&
		!loading &&
		Boolean(view?.live && view.canChange) &&
		!changing &&
		['enabled', 'disabled', 'installed'].includes(plugin.status)
	const clearError = () =>
		setState((current) =>
			current.scope === scope && current.generation === owner.current.generation
				? { ...current, error: undefined }
				: { scope, generation: owner.current.generation },
		)
	const change = async (plugin: ComposerPlugin) => {
		if (!canChange(plugin) || owner.current.admitted || !owner.current.mounted) return
		const target = scope
		const generation = owner.current.generation
		const current = () =>
			owner.current.mounted &&
			owner.current.scope === target &&
			owner.current.generation === generation
		owner.current.admitted = true
		setState({
			scope: target,
			generation,
			changing: `${plugin.scope}:${plugin.name}`,
		})
		try {
			await onSetEnabled(plugin, plugin.status !== 'enabled')
		} catch (error) {
			if (current())
				setState({
					scope: target,
					generation,
					changing: `${plugin.scope}:${plugin.name}`,
					errorPlugin: `${plugin.scope}:${plugin.name}`,
					error: error instanceof Error ? error.message : String(error),
				})
		} finally {
			if (current()) {
				owner.current.admitted = false
				setState((current) => ({ ...current, changing: undefined }))
			}
		}
	}
	return { changing, error, errorPlugin, canChange, clearError, change }
}

export function PluginInventoryCard({
	plugin,
	view,
	inventory,
}: {
	plugin: ComposerPlugin
	view: ComposerPluginInventory
	inventory: ReturnType<typeof usePluginInventory>
}) {
	const changing = inventory.changing === `${plugin.scope}:${plugin.name}`
	return (
		<div className="rounded-lg border border-border p-3">
			<div className="flex items-center justify-between gap-3">
				<span className="min-w-0 truncate text-sm font-medium" title={plugin.name}>
					{plugin.name}
				</span>
				{view.live && (
					<PluginInventoryAction plugin={plugin} inventory={inventory} changing={changing} />
				)}
			</div>
			<p className="mt-1 text-xs text-muted-foreground">
				{plugin.version && `${plugin.version} · `}
				{plugin.scope === 'user' ? 'Personal' : 'Project'} ·{' '}
				{view.live ? plugin.status : plugin.status === 'error' ? 'Unavailable' : 'Installed'}
			</p>
			{plugin.description && (
				<p className="mt-1 text-xs text-muted-foreground">{plugin.description}</p>
			)}
			<p className="mt-1 text-xs text-muted-foreground">{pluginStartupLabel(plugin)}</p>
			{plugin.startupError && (
				<p className="mt-1 text-xs text-destructive">{plugin.startupError}</p>
			)}
		</div>
	)
}

function pluginStartupLabel(plugin: ComposerPlugin) {
	return plugin.startupEnabled === undefined
		? 'Saved setting unavailable'
		: plugin.startupEnabled
			? 'Starts enabled next time'
			: 'Starts disabled next time'
}

export function PluginInventoryRow({
	plugin,
	collection,
	canTry,
	onTry,
	onOpen,
}: {
	plugin: ComposerPlugin | ComposerPublicPlugin
	collection: PluginCollection
	canTry: boolean
	onTry: () => void
	onOpen: () => void
}) {
	const installed = 'scope' in plugin ? plugin : undefined
	return (
		<div className="plugins-page-row">
			<button
				type="button"
				id={pluginRowId({ ...plugin, collection })}
				className="plugins-page-row-main"
				aria-label={`Open ${plugin.name} plugin`}
				onClick={onOpen}
			>
				<span className="plugins-page-row-icon" aria-hidden="true">
					<PuzzleIcon />
				</span>
				<span className="plugins-page-row-copy">
					<span className="plugins-page-row-title" title={plugin.name}>
						{plugin.name}
					</span>
					<span className="plugins-page-row-description">{plugin.description}</span>
					{installed?.status === 'error' && <span className="plugins-page-error">Unavailable</span>}
				</span>
			</button>
			<PluginActions pluginName={plugin.name} canTry={canTry} onTry={onTry} onManage={onOpen} />
		</div>
	)
}

export function pluginRowId(plugin: {
	name: string
	scope?: string
	collection?: PluginCollection
}) {
	return `plugin-open-${plugin.collection ?? 'personal'}-${encodeURIComponent(plugin.scope ?? 'catalogue')}-${encodeURIComponent(plugin.name)}`
}

function PluginInventoryAction({
	plugin,
	inventory,
	changing,
}: {
	plugin: ComposerPlugin
	inventory: ReturnType<typeof usePluginInventory>
	changing: boolean
}) {
	return (
		<Button
			variant="ghost-muted"
			size="xs"
			disabled={!inventory.canChange(plugin)}
			onClick={() => void inventory.change(plugin)}
			aria-label={`${plugin.status === 'enabled' ? 'Disable' : 'Enable'} ${plugin.name}`}
		>
			{changing ? 'Changing…' : plugin.status === 'enabled' ? 'Disable' : 'Enable'}
		</Button>
	)
}

export function ComposerPlugins(props: PluginMenuProps) {
	return <PluginMenu {...props} />
}

/** The composer menu and full page share the exact conversation's inventory. */
function PluginMenu({
	scope,
	view,
	loading,
	disabled,
	contextLabel,
	onOpen,
	onSetEnabled,
}: PluginMenuProps) {
	const [open, setOpen] = useState(false)
	const inventory = usePluginInventory({
		scope,
		view,
		loading,
		disabled,
		onSetEnabled,
	})
	const menuScope = useRef(scope)
	useEffect(() => {
		if (menuScope.current === scope) return
		menuScope.current = scope
		setOpen(false)
	}, [scope])
	const trigger = (
		<PopoverTrigger render={<ComposerControl size="xs" disabled={disabled} aria-label="Plugins" />}>
			<PuzzleIcon className="size-3.5" />
			Plugins
			<ComposerControlChevron size="xs" />
		</PopoverTrigger>
	)
	return (
		<Popover
			open={open && !disabled}
			onOpenChange={(next) => {
				setOpen(next)
				if (next) {
					inventory.clearError()
					onOpen()
				}
			}}
		>
			{trigger}
			<PopoverPopup
				side="top"
				align="start"
				sideOffset={4}
				aria-label="Plugins"
				width="lg"
				padding="compact"
				className="max-h-[min(28rem,var(--available-height))] overflow-y-auto"
			>
				<h2 className="text-sm font-medium">Plugins</h2>
				{contextLabel && <p className="mt-1 text-xs text-muted-foreground">{contextLabel}</p>}
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
				{inventory.error && (
					<p role="alert" className="mt-2 text-xs text-destructive">
						{inventory.error}
					</p>
				)}
				{view && view.plugins.length === 0 && !view.notice && !loading && (
					<p className="mt-2 text-xs text-muted-foreground">
						No plugins are loaded in this conversation.
					</p>
				)}
				<ul className="mt-3 space-y-2">
					{view?.plugins.map((plugin) => (
						<li key={`${plugin.scope}:${plugin.name}`}>
							<PluginInventoryCard plugin={plugin} view={view} inventory={inventory} />
						</li>
					))}
				</ul>
			</PopoverPopup>
		</Popover>
	)
}
