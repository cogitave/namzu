import { Tabs } from '@base-ui/react/tabs'
import type {
	ComposerPlugin,
	ComposerPluginInventory,
	usePluginInventory,
} from './composer-plugins.js'
import {
	NO_PLUGINS,
	NO_PLUGINS_NOTE,
	USE_SKILLS_NOTE,
	longUpdated,
	shortUpdated,
} from './customize-model.js'
import {
	Chip,
	DetailFrame,
	DetailTabs,
	EmptyState,
	GroupHeading,
	type MenuEntry,
	MoreMenu,
	Tile,
} from './customize-parts.js'
import {
	PLACED_NOTE,
	type PluginGroup,
	groupPlugins,
	isManaged,
	noUpdateReason,
	updateWords,
} from './customize-plugins-model.js'
import { LoaderCircleIcon, PuzzleIcon } from './icons.js'
import { Switch } from './settings-row.js'
import { Button } from './ui/button.js'
import type { PluginActions } from './use-plugin-actions.js'

type Inventory = ReturnType<typeof usePluginInventory>

export const pluginIsOff = (plugin: ComposerPlugin, live: boolean): boolean =>
	live ? plugin.status === 'disabled' : plugin.startupEnabled === false

const pluginPlace = (plugin: ComposerPlugin) => (plugin.scope === 'user' ? 'Yours' : 'This project')

/** Why a plugin cannot be switched now, in the words the old page used; nothing when it can. */
export function pluginChangeNotice(view: ComposerPluginInventory | undefined): string | undefined {
	if (!view) return undefined
	if (view.live && !view.canChange) return 'Finish the active work before changing plugins.'
	if (!view.live && !view.notice) return 'Open a conversation to enable or disable plugins.'
	return undefined
}

const turnEntry = (
	plugin: ComposerPlugin,
	view: ComposerPluginInventory,
	inventory: Inventory,
): MenuEntry => ({
	label: pluginIsOff(plugin, view.live) ? 'Turn on' : 'Turn off',
	disabled: !inventory.canChange(plugin),
	title: !inventory.canChange(plugin) ? pluginChangeNotice(view) : undefined,
	onSelect: () => void inventory.change(plugin),
})

/** What the row and detail menus of a plugin can do beyond the live switch: only for one Namzu installed. */
export interface PluginRowActions {
	actions: PluginActions
	/** Turns it off (after a confirm) or on, in its saved record. */
	onToggle: (plugin: ComposerPlugin, on: boolean) => void
	onRemove: (plugin: ComposerPlugin) => void
}

/** The entries of a plugin's menu, in the order of the design: switch, check, details, then remove. */
export function pluginEntries(
	plugin: ComposerPlugin,
	view: ComposerPluginInventory,
	inventory: Inventory,
	row: PluginRowActions | undefined,
	onOpen?: (plugin: ComposerPlugin) => void,
): MenuEntry[] {
	const entries: MenuEntry[] = []
	const off = pluginIsOff(plugin, view.live)
	if (row && isManaged(plugin))
		entries.push({
			label: off ? 'Turn on' : 'Turn off',
			disabled: inventory.changing !== undefined,
			onSelect: () => row.onToggle(plugin, off),
		})
	else entries.push(turnEntry(plugin, view, inventory))
	if (row) {
		const reason = noUpdateReason(plugin)
		const state = plugin.id ? row.actions.states[plugin.id] : undefined
		entries.push({
			label: 'Check for updates',
			disabled: Boolean(reason) || state?.kind === 'checking' || state?.kind === 'updating',
			title: reason,
			onSelect: () => void row.actions.check(plugin),
		})
		if (state?.kind === 'available')
			entries.push({ label: 'Update', onSelect: () => void row.actions.update(plugin) })
	}
	if (onOpen) entries.push({ label: 'Details', onSelect: () => onOpen(plugin) })
	if (row && isManaged(plugin))
		entries.push({ label: 'Remove', danger: true, onSelect: () => row.onRemove(plugin) })
	return entries
}

function PluginGroupList({
	group,
	view,
	inventory,
	now,
	onOpen,
	row,
}: {
	group: PluginGroup
	view: ComposerPluginInventory
	inventory: Inventory
	now: number
	onOpen: (plugin: ComposerPlugin) => void
	row?: PluginRowActions
}) {
	const plugins = group.plugins
	return (
		<section className="customize-group" aria-label={`${group.title} plugins`}>
			<GroupHeading title={group.title} count={plugins.length} />
			<ul className="customize-list">
				{plugins.map((plugin) => {
					const off = pluginIsOff(plugin, view.live)
					const words = updateWords(plugin.id ? row?.actions.states[plugin.id] : undefined)
					return (
						<li
							key={`${plugin.scope}:${plugin.name}`}
							className="customize-row"
							data-off={off || undefined}
							data-update={
								(plugin.id && row?.actions.states[plugin.id]?.kind === 'available') || undefined
							}
						>
							<button
								type="button"
								className="customize-row-main"
								aria-label={`Open ${plugin.name}`}
								onClick={() => onOpen(plugin)}
							>
								<Tile icon={PuzzleIcon} />
								<span className="customize-row-copy">
									<span className="customize-row-title">
										<span className="customize-name" title={plugin.name}>
											{plugin.name}
										</span>
										{plugin.version && <Chip>{plugin.version}</Chip>}
										{off && <Chip>Off</Chip>}
										{plugin.status === 'error' && <Chip>Unavailable</Chip>}
										{words ? (
											<Chip>{words}</Chip>
										) : (
											plugin.updateKnown && <Chip>Update available</Chip>
										)}
									</span>
									<span className="customize-row-sub">
										{plugin.description
											? `${pluginPlace(plugin)} · ${plugin.description}`
											: pluginPlace(plugin)}
									</span>
								</span>
								<span className="customize-row-time">{shortUpdated(plugin.updatedAt, now)}</span>
							</button>
							{plugin.id && row?.actions.states[plugin.id]?.kind === 'available' && (
								<Button
									variant="outline"
									size="sm"
									className="customize-row-update"
									aria-label={`Update ${plugin.name}`}
									onClick={() => void row.actions.update(plugin)}
								>
									Update
								</Button>
							)}
							<MoreMenu
								label={`Actions for ${plugin.name}`}
								items={pluginEntries(plugin, view, inventory, row, onOpen)}
							/>
						</li>
					)
				})}
			</ul>
		</section>
	)
}

/** The installed plugins, grouped by the marketplace each came from; a plugin placed by hand is under Installed. */
export function PluginsList({
	plugins,
	...rest
}: {
	plugins: readonly ComposerPlugin[]
	view: ComposerPluginInventory
	inventory: Inventory
	now: number
	onOpen: (plugin: ComposerPlugin) => void
	row?: PluginRowActions
}) {
	return (
		<>
			{groupPlugins(plugins).map((group) => (
				<PluginGroupList key={group.key} group={group} {...rest} />
			))}
		</>
	)
}

export function PluginsEmpty({
	searching,
	disabled,
	onChooseSpace,
	onAddMarketplace,
	onUpload,
}: {
	searching: boolean
	disabled: boolean
	onChooseSpace: () => void
	/** Where there is a way to add one: the two entries the Add menu has. */
	onAddMarketplace?: () => void
	onUpload?: () => void
}) {
	if (disabled)
		return (
			<EmptyState
				action={
					<Button variant="outline" size="sm" onClick={onChooseSpace}>
						Choose a space
					</Button>
				}
			>
				Open a trusted project to see its installed plugins.
			</EmptyState>
		)
	if (searching) return <EmptyState>No plugins match your search.</EmptyState>
	return (
		<EmptyState
			action={
				<>
					{(onAddMarketplace || onUpload) && (
						<div className="customize-empty-actions">
							{onAddMarketplace && (
								<Button variant="outline" size="sm" onClick={onAddMarketplace}>
									Add marketplace
								</Button>
							)}
							{onUpload && (
								<Button variant="outline" size="sm" onClick={onUpload}>
									Upload plugin
								</Button>
							)}
						</div>
					)}
					<p className="customize-footnote">{NO_PLUGINS_NOTE}</p>
				</>
			}
		>
			{NO_PLUGINS}
		</EmptyState>
	)
}

export type PluginDetailTab = 'overview' | 'skills' | 'connectors'

function pluginStatus(plugin: ComposerPlugin, live: boolean): string {
	if (!live) return plugin.status === 'error' ? 'Unavailable' : 'Installed'
	return (
		{ enabled: 'Enabled', disabled: 'Disabled', installed: 'Installed', error: 'Unavailable' }[
			plugin.status
		] ?? plugin.status
	)
}

export function PluginDetail({
	plugin,
	view,
	inventory,
	now,
	tab,
	onTab,
	onBack,
	row,
}: {
	plugin: ComposerPlugin
	view: ComposerPluginInventory
	inventory: Inventory
	now: number
	tab: PluginDetailTab
	onTab: (tab: PluginDetailTab) => void
	onBack: () => void
	row?: PluginRowActions
}) {
	const off = pluginIsOff(plugin, view.live)
	const skills = plugin.skills ?? []
	const servers = plugin.servers ?? []
	const changing = inventory.changing === `${plugin.scope}:${plugin.name}`
	const updated = longUpdated(plugin.updatedAt, now)
	const notice = pluginChangeNotice(view)
	const subtitle = [
		pluginPlace(plugin),
		plugin.version,
		skills.length > 0 ? `${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}` : '',
		updated ? `updated ${updated}` : '',
	]
		.filter(Boolean)
		.join(' · ')
	const change = turnEntry(plugin, view, inventory)
	const managed = Boolean(row) && isManaged(plugin)
	const entries = pluginEntries(plugin, view, inventory, row)
	const words = updateWords(plugin.id ? row?.actions.states[plugin.id] : undefined)
	return (
		<DetailFrame
			backLabel="Your plugins"
			onBack={onBack}
			tile={<Tile icon={PuzzleIcon} size={44} />}
			title={plugin.name}
			subtitle={subtitle}
			note={
				<>
					{managed ? undefined : (view.notice ?? notice)}
					{!plugin.id && row && <span>{PLACED_NOTE}</span>}
					{words && <output>{words}</output>}
					{inventory.error && (
						<span role="alert" className="customize-error">
							{inventory.error}
						</span>
					)}
				</>
			}
			actions={
				<>
					{changing && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
					{row?.actions.states[plugin.id ?? '']?.kind === 'available' && (
						<Button variant="outline" size="sm" onClick={() => void row?.actions.update(plugin)}>
							Update
						</Button>
					)}
					<MoreMenu label={`Actions for ${plugin.name}`} items={entries} />
					<Switch
						label={`Use ${plugin.name}`}
						checked={!off}
						disabled={managed ? inventory.changing !== undefined : change.disabled}
						onChange={() =>
							managed && row ? row.onToggle(plugin, off) : void inventory.change(plugin)
						}
					/>
				</>
			}
		>
			<Tabs.Root value={tab} onValueChange={(value) => onTab(value as PluginDetailTab)}>
				<DetailTabs
					label="Plugin sections"
					onChange={onTab}
					tabs={[
						{ id: 'overview', label: 'Overview' },
						{ id: 'skills', label: 'Skills', count: skills.length },
						{ id: 'connectors', label: 'Connectors', count: servers.length },
					]}
				/>
				<Tabs.Panel value="overview" className="customize-panel">
					<div className="customize-overview">
						<div className="customize-overview-main">
							<h3 className="customize-label">Description</h3>
							<p className="customize-description">{plugin.description || '—'}</p>
							<h3 className="customize-label">Information</h3>
							<dl className="customize-info">
								<div>
									<dt>Installation</dt>
									<dd>{pluginPlace(plugin)}</dd>
								</div>
								{plugin.version && (
									<div>
										<dt>Version</dt>
										<dd>{plugin.version}</dd>
									</div>
								)}
								{plugin.author && (
									<div>
										<dt>Author</dt>
										<dd>{plugin.author}</dd>
									</div>
								)}
								<div>
									<dt>{view.live ? 'Current status' : 'Status'}</dt>
									<dd>{pluginStatus(plugin, view.live)}</dd>
								</div>
								<div>
									<dt>Starts next time</dt>
									<dd>
										{plugin.startupEnabled === undefined
											? 'Saved setting unavailable'
											: plugin.startupEnabled
												? 'Enabled'
												: 'Disabled'}
									</dd>
								</div>
								{plugin.startupError && (
									<div>
										<dt>Startup error</dt>
										<dd className="customize-error">{plugin.startupError}</dd>
									</div>
								)}
							</dl>
						</div>
					</div>
				</Tabs.Panel>
				<Tabs.Panel value="skills" className="customize-panel">
					<p className="customize-muted">{USE_SKILLS_NOTE}</p>
					{skills.length === 0 ? (
						<p className="customize-muted">This plugin brings no skills.</p>
					) : (
						<ul className="customize-list">
							{skills.map((skill) => (
								<li key={skill.name} className="customize-row customize-row-static">
									<span className="customize-row-main">
										<Tile icon={PuzzleIcon} />
										<span className="customize-row-copy">
											<span className="customize-row-title">
												<span className="customize-name">/{skill.name}</span>
											</span>
											<span className="customize-row-sub">{skill.description}</span>
										</span>
									</span>
								</li>
							))}
						</ul>
					)}
				</Tabs.Panel>
				<Tabs.Panel value="connectors" className="customize-panel">
					{servers.length === 0 ? (
						<p className="customize-muted">This plugin brings no connectors.</p>
					) : (
						<ul className="customize-list">
							{servers.map((server) => (
								<li key={server.name} className="customize-row customize-row-static">
									<span className="customize-row-main">
										<Tile icon={PuzzleIcon} />
										<span className="customize-row-copy">
											<span className="customize-row-title">
												<span className="customize-name">{server.name}</span>
											</span>
											<span className="customize-row-sub">Starts with the plugin</span>
										</span>
									</span>
								</li>
							))}
						</ul>
					)}
				</Tabs.Panel>
			</Tabs.Root>
		</DetailFrame>
	)
}
