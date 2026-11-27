import { Tabs } from '@base-ui/react/tabs'
import type {
	ComposerPlugin,
	ComposerPluginInventory,
	usePluginInventory,
} from './composer-plugins.js'
import { NO_PLUGINS, USE_SKILLS_NOTE, longUpdated, shortUpdated } from './customize-model.js'
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
import { LoaderCircleIcon, PuzzleIcon } from './icons.js'
import { Switch } from './settings-row.js'
import { Button } from './ui/button.js'

type Inventory = ReturnType<typeof usePluginInventory>

export const pluginIsOff = (plugin: ComposerPlugin, live: boolean): boolean =>
	live ? plugin.status === 'disabled' : plugin.startupEnabled === false

const pluginPlace = (plugin: ComposerPlugin) => (plugin.scope === 'user' ? 'user' : 'project')

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

export function PluginsList({
	plugins,
	view,
	inventory,
	now,
	onOpen,
}: {
	plugins: readonly ComposerPlugin[]
	view: ComposerPluginInventory
	inventory: Inventory
	now: number
	onOpen: (plugin: ComposerPlugin) => void
}) {
	return (
		<section className="customize-group" aria-label="Installed plugins">
			<GroupHeading title="Installed" count={plugins.length} />
			<ul className="customize-list">
				{plugins.map((plugin) => {
					const off = pluginIsOff(plugin, view.live)
					return (
						<li
							key={`${plugin.scope}:${plugin.name}`}
							className="customize-row"
							data-off={off || undefined}
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
									</span>
									<span className="customize-row-sub">
										{plugin.description
											? `${pluginPlace(plugin)} · ${plugin.description}`
											: pluginPlace(plugin)}
									</span>
								</span>
								<span className="customize-row-time">{shortUpdated(plugin.updatedAt, now)}</span>
							</button>
							<MoreMenu
								label={`Actions for ${plugin.name}`}
								items={[
									turnEntry(plugin, view, inventory),
									{ label: 'Details', onSelect: () => onOpen(plugin) },
								]}
							/>
						</li>
					)
				})}
			</ul>
		</section>
	)
}

export function PluginsEmpty({
	searching,
	disabled,
	onChooseSpace,
}: { searching: boolean; disabled: boolean; onChooseSpace: () => void }) {
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
	return <EmptyState>{searching ? 'No plugins match your search.' : NO_PLUGINS}</EmptyState>
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
}: {
	plugin: ComposerPlugin
	view: ComposerPluginInventory
	inventory: Inventory
	now: number
	tab: PluginDetailTab
	onTab: (tab: PluginDetailTab) => void
	onBack: () => void
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
	return (
		<DetailFrame
			backLabel="Your plugins"
			onBack={onBack}
			tile={<Tile icon={PuzzleIcon} size={44} />}
			title={plugin.name}
			subtitle={subtitle}
			note={
				<>
					{view.notice ?? notice}
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
					<MoreMenu label={`Actions for ${plugin.name}`} items={[change]} />
					<Switch
						label={`Use ${plugin.name}`}
						checked={!off}
						disabled={change.disabled}
						onChange={() => void inventory.change(plugin)}
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
									<dd>{plugin.scope === 'user' ? 'Personal' : 'Project'}</dd>
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
