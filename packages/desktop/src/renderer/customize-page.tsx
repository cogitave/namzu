import { Tabs } from '@base-ui/react/tabs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { skillsDisabledValue } from '../shared/config-lists-values.js'
import type { DesktopApi } from '../shared/protocol.js'
import {
	type ComposerPlugin,
	type PluginInventoryProps,
	usePluginInventory,
} from './composer-plugins.js'
import { stateFor } from './config-settings-model.js'
import { ConfirmRemovalDialog } from './confirm-removal-dialog.js'
import { removeBody, removeTitle } from './customize-actions-model.js'
import { AddConnectorDialog, CreateSkillDialog, UploadSkillPage } from './customize-actions.js'
import { ConnectorsTable } from './customize-connectors.js'
import {
	type CustomizeTab,
	type SkillRowModel,
	type SkillSort,
	connectorRows,
	groupSkills,
	withSwitchLocks,
} from './customize-model.js'
import { type AddMenuModel, CustomizeHeader, type MenuEntry } from './customize-parts.js'
import {
	AddMarketplaceDialog,
	DiscoverGrid,
	InstallSheet,
	MarketplacesList,
	RemoveMarketplaceDialog,
	RemovePluginDialog,
	UpdateSheet,
	UploadPluginPage,
} from './customize-plugin-parts.js'
import { TURN_OFF_BODY, installedFrom, turnOffTitle } from './customize-plugins-model.js'
import {
	PluginDetail,
	type PluginDetailTab,
	type PluginRowActions,
	PluginsEmpty,
	PluginsList,
} from './customize-plugins.js'
import {
	SkillContents,
	SkillDetail,
	type SkillDetailTab,
	SkillsEmpty,
	SkillsList,
} from './customize-skills.js'
import { FolderPlusIcon, PencilIcon, PlusIcon, UploadIcon } from './icons.js'
import { notify } from './notify.js'
import { plainErrorText } from './plain-error.js'
import { NEW_PLUGIN_EVENT, PLUGINS_CHANGED_EVENT } from './plugin-create.js'
import { foldedIncludes } from './text-fold.js'
import { useConfigSettings } from './use-config-settings.js'
import { useCustomizeSkills, useSkillFiles } from './use-customize-skills.js'
import { useMarketplaces } from './use-marketplaces.js'
import { useMcpServers } from './use-mcp-servers.js'
import { usePluginActions } from './use-plugin-actions.js'
import { useUserMcpServers } from './use-user-mcp-servers.js'
import './customize-page.css'

export interface CustomizePageProps extends PluginInventoryProps {
	api: DesktopApi
	/** The open project, when it is trusted and ready; skills and servers are read for it. */
	projectId?: string
	tab: CustomizeTab
	onTabChange: (tab: CustomizeTab) => void
	onLoadPlugins: () => void
	onChooseSpace: () => void
	onCreateSkill: () => void
	onTryInChat: (name: string) => void
	/** Opens Settings on the tool servers, on the named one when there is one. */
	onOpenConnector: (name?: string) => void
	onAddConnector: () => void
}

const DAY_TICK = 60_000

/** The one Customize page: Skills, Connectors and Plugins, each with a list and a detail. */
export function CustomizePage({
	api,
	projectId,
	tab,
	onTabChange,
	onLoadPlugins,
	onChooseSpace,
	onCreateSkill,
	onTryInChat,
	onOpenConnector,
	onAddConnector,
	...plugins
}: CustomizePageProps) {
	const [query, setQuery] = useState('')
	const [sort, setSort] = useState<SkillSort>('name')
	const [skillName, setSkillName] = useState<string>()
	const [skillTab, setSkillTab] = useState<SkillDetailTab>('overview')
	const [pluginKey, setPluginKey] = useState<string>()
	const [pluginTab, setPluginTab] = useState<PluginDetailTab>('overview')
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), DAY_TICK)
		return () => window.clearInterval(timer)
	}, [])
	const root = useRef<HTMLElement>(null)
	const [upload, setUpload] = useState(false)
	const [uploadPlugin, setUploadPlugin] = useState(false)
	const [pluginView, setPluginView] = useState<'yours' | 'discover'>('yours')
	// A skill just made is selected once the list has read it.
	const [pendingSelect, setPendingSelect] = useState<string>()
	const [dialog, setDialog] = useState<
		| 'create'
		| 'connector'
		| 'marketplace'
		| { remove: SkillRowModel }
		| { removePlugin: ComposerPlugin }
		| { removeMarketplace: string }
		| { turnOff: ComposerPlugin }
		| { install: { id: string; name: string } }
		| { update: true }
	>()
	// The button that opened a dialog gets the focus back when it closes.
	const opener = useRef<HTMLElement | null>(null)
	const openDialog = (next: NonNullable<typeof dialog>) => {
		opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
		setDialog(next)
	}
	const returnFocus = () => opener.current
	// Another tab, another search: what was typed for one list means nothing in the next.
	const change = (next: CustomizeTab) => {
		setQuery('')
		setSkillName(undefined)
		setPluginKey(undefined)
		setUpload(false)
		setUploadPlugin(false)
		onTabChange(next)
	}

	// Skills
	const config = useConfigSettings(api, true, projectId)
	const disabledValue = config.view ? stateFor(config.view, 'skills.disabled')?.value : undefined
	const skills = useCustomizeSkills(api, projectId, disabledValue, true)
	const rows = useMemo(
		() => (skills.rows ? withSwitchLocks(skills.rows, disabledValue) : undefined),
		[skills.rows, disabledValue],
	)
	const skill = skillName ? rows?.find((row) => row.name === skillName) : undefined
	const toggleSkill = async (row: SkillRowModel, on: boolean) => {
		await config.change('skills.disabled', skillsDisabledValue(disabledValue, row.name, on))
		skills.reload()
	}
	const files = useSkillFiles(
		api,
		skill?.name ?? '',
		projectId,
		skill !== undefined && skillTab === 'contents' && !skill.basic,
	)
	useEffect(() => {
		if (pendingSelect && rows?.some((row) => row.name === pendingSelect)) {
			setSkillTab('overview')
			setSkillName(pendingSelect)
			setPendingSelect(undefined)
		} else if (skillName && rows && !skill) setSkillName(undefined)
	}, [skillName, rows, skill, pendingSelect])

	// Plugins
	const inventory = usePluginInventory(plugins)
	const { view, loading, disabled, scope } = plugins
	const loaded = useRef<string | undefined>(undefined)
	useEffect(() => {
		if (tab !== 'plugins') return
		if (disabled) {
			loaded.current = undefined
			return
		}
		if (loaded.current !== scope) {
			loaded.current = scope
			onLoadPlugins()
		}
	}, [tab, scope, disabled, onLoadPlugins])
	// The marketplaces and what an installed plugin can be asked to do come from the engine; an older one has neither.
	const markets = useMarketplaces(api, projectId, tab === 'plugins', pluginView === 'discover')
	const pluginActions = usePluginActions(api, projectId, {
		view,
		change: inventory.change,
		canChange: inventory.canChange,
	})
	const canManagePlugins = markets.view !== undefined
	const marketCount = markets.view?.marketplaces.length ?? 0
	// Discover needs a marketplace to read; with none, the page is on Yours whatever was asked for.
	const discovering = pluginView === 'discover' && marketCount > 0
	useEffect(() => {
		const again = () => {
			if (!disabled) onLoadPlugins()
		}
		window.addEventListener(PLUGINS_CHANGED_EVENT, again)
		return () => window.removeEventListener(PLUGINS_CHANGED_EVENT, again)
	}, [disabled, onLoadPlugins])
	const turnPlugin = (entry: ComposerPlugin, on: boolean) => {
		if (on)
			void pluginActions
				.setSaved(entry, true)
				.catch((failure) => notify(plainErrorText(failure, 'change the plugin'), { tone: 'error' }))
		else openDialog({ turnOff: entry })
	}
	const rowActions: PluginRowActions | undefined = canManagePlugins
		? {
				actions: pluginActions,
				onToggle: turnPlugin,
				onRemove: (entry) => openDialog({ removePlugin: entry }),
			}
		: undefined
	const plugin = pluginKey
		? view?.plugins.find((entry) => `${entry.scope}:${entry.name}` === pluginKey)
		: undefined
	useEffect(() => {
		if (pluginKey && view && !loading && !plugin) setPluginKey(undefined)
	}, [pluginKey, view, loading, plugin])

	// Connectors
	const servers = useMcpServers(api, tab === 'connectors' ? projectId : undefined)
	const own = useUserMcpServers(tab === 'connectors' ? api : undefined, servers.reload)
	const connectors = connectorRows(servers.view, own?.view?.servers).filter(
		(row) => !query.trim() || foldedIncludes(`${row.name} ${row.type} ${row.source}`, query),
	)

	const searchLabel = `Search ${tab}`
	// An engine that cannot stage or make skills hides the entries it cannot serve.
	const canManage = Boolean(rows) && !skills.basic && skills.canManage && Boolean(api.stageSkills)
	const skillEntries: MenuEntry[] = [
		...(canManage
			? [
					{ label: 'Upload skill', icon: UploadIcon, onSelect: () => setUpload(true) },
					{ label: 'Create a skill', icon: PencilIcon, onSelect: () => openDialog('create') },
				]
			: []),
		{ label: 'Create with Namzu', icon: PlusIcon, onSelect: onCreateSkill },
	]
	const pluginEntries: MenuEntry[] = [
		...(canManagePlugins
			? [
					{
						label: 'Add marketplace',
						icon: FolderPlusIcon,
						onSelect: () => openDialog('marketplace'),
					},
					{ label: 'Upload plugin', icon: UploadIcon, onSelect: () => setUploadPlugin(true) },
				]
			: []),
		{
			label: 'Create with Namzu',
			icon: PlusIcon,
			onSelect: () => window.dispatchEvent(new Event(NEW_PLUGIN_EVENT)),
		},
	]
	const add: AddMenuModel | undefined =
		tab === 'skills'
			? { items: skillEntries }
			: tab === 'plugins'
				? { items: pluginEntries }
				: tab === 'connectors'
					? {
							items: [
								{
									label: 'Add custom connector',
									icon: PlusIcon,
									onSelect: () => (own ? openDialog('connector') : onAddConnector()),
								},
							],
						}
					: undefined
	const removeSkill = async (row: SkillRowModel) => {
		if (!api.removeSkill || (row.tier !== 'user' && row.tier !== 'project')) return
		const answer = await api.removeSkill(row.name, row.tier, projectId)
		if (!answer) throw new Error('Update Namzu to remove skills from here.')
		if (answer.outcome !== 'removed') throw new Error(answer.error ?? 'The skill was not removed.')
		notify(`Removed ${row.name}. A copy is kept in Namzu's backups.`, { tone: 'success' })
		setSkillName(undefined)
		skills.reload()
	}

	const detail = (() => {
		if (tab === 'skills' && skill)
			return (
				<SkillDetail
					skill={skill}
					now={now}
					tab={skillTab}
					onTab={setSkillTab}
					onBack={() => setSkillName(undefined)}
					onToggle={(on) => void toggleSkill(skill, on)}
					onTry={() => onTryInChat(skill.name)}
					onRemove={canManage ? (row) => openDialog({ remove: row }) : undefined}
					switchDisabled={
						skill.plugin
							? `Follows the ${skill.plugin} plugin; turn the plugin off or on.`
							: undefined
					}
					contents={
						skill.basic ? undefined : (
							<SkillContents
								api={api}
								name={skill.name}
								projectId={projectId}
								files={files.files}
								error={files.error}
							/>
						)
					}
				/>
			)
		if (tab === 'plugins' && plugin && view)
			return (
				<PluginDetail
					plugin={plugin}
					view={view}
					inventory={inventory}
					now={now}
					tab={pluginTab}
					onTab={setPluginTab}
					onBack={() => setPluginKey(undefined)}
					row={rowActions}
				/>
			)
		return undefined
	})()

	const shownPlugins = (view?.plugins ?? []).filter(
		(entry) =>
			!query.trim() || foldedIncludes(`${entry.name} ${entry.description} ${entry.version}`, query),
	)
	const orderedPlugins = useMemo(
		() =>
			[...shownPlugins].sort((a, b) =>
				sort === 'updated'
					? (b.updatedAt ? Date.parse(b.updatedAt) : 0) -
							(a.updatedAt ? Date.parse(a.updatedAt) : 0) || a.name.localeCompare(b.name)
					: a.name.localeCompare(b.name),
			),
		[shownPlugins, sort],
	)
	const groups = rows ? groupSkills(rows, { query, sort }) : []

	const dialogs = (
		<>
			{dialog === 'create' && (
				<CreateSkillDialog
					api={api}
					projectId={projectId}
					returnFocus={returnFocus}
					onClose={() => setDialog(undefined)}
					onCreated={(name) => {
						setDialog(undefined)
						setPendingSelect(name)
						skills.reload()
					}}
				/>
			)}
			{dialog === 'connector' && own && (
				<AddConnectorDialog
					returnFocus={returnFocus}
					onClose={() => setDialog(undefined)}
					save={(change) => own.save(change)}
					onSaved={(name) => {
						setDialog(undefined)
						notify(`Added ${name}. It loads in new conversations.`, { tone: 'success' })
					}}
				/>
			)}
			{dialog === 'marketplace' && (
				<AddMarketplaceDialog
					api={api}
					projectId={projectId}
					returnFocus={returnFocus}
					onClose={() => setDialog(undefined)}
					onAdded={() => {
						setDialog(undefined)
						setPluginView('discover')
					}}
				/>
			)}
			{typeof dialog === 'object' && 'removePlugin' in dialog && (
				<RemovePluginDialog
					name={dialog.removePlugin.name}
					returnFocus={returnFocus}
					onClose={() => setDialog(undefined)}
					onRemove={(deleteData) => {
						const target = dialog.removePlugin
						return pluginActions.remove(target, deleteData).then(() => setPluginKey(undefined))
					}}
				/>
			)}
			{typeof dialog === 'object' && 'removeMarketplace' in dialog && (
				<RemoveMarketplaceDialog
					name={dialog.removeMarketplace}
					installed={installedFrom(view?.plugins ?? [], dialog.removeMarketplace)}
					returnFocus={returnFocus}
					onClose={() => setDialog(undefined)}
					onRemove={() =>
						pluginActions.removeMarket((dialog as { removeMarketplace: string }).removeMarketplace)
					}
				/>
			)}
			{typeof dialog === 'object' && 'turnOff' in dialog && (
				<ConfirmRemovalDialog
					title={turnOffTitle(dialog.turnOff.name)}
					description={TURN_OFF_BODY}
					actionLabel="Turn off"
					pendingLabel="Turning off…"
					returnFocus={returnFocus}
					onConfirm={() =>
						pluginActions.setSaved((dialog as { turnOff: ComposerPlugin }).turnOff, false)
					}
					onClose={() => setDialog(undefined)}
				/>
			)}
			{typeof dialog === 'object' && 'install' in dialog && (
				<InstallSheet
					api={api}
					plugin={dialog.install}
					projectId={projectId}
					returnFocus={returnFocus}
					onClose={() => setDialog(undefined)}
					onInstalled={() => setDialog(undefined)}
				/>
			)}
			{pluginActions.pendingUpdate && (
				<UpdateSheet
					api={api}
					update={pluginActions.pendingUpdate.update}
					name={pluginActions.pendingUpdate.plugin.name}
					projectId={projectId}
					returnFocus={returnFocus}
					onClose={pluginActions.clearPendingUpdate}
					onUpdated={(message) => {
						pluginActions.clearPendingUpdate()
						notify(message, { tone: 'success' })
						window.dispatchEvent(new Event(PLUGINS_CHANGED_EVENT))
					}}
				/>
			)}
			{typeof dialog === 'object' && 'remove' in dialog && (
				<ConfirmRemovalDialog
					title={removeTitle}
					description={removeBody(dialog.remove.name)}
					actionLabel="Remove"
					returnFocus={returnFocus}
					onConfirm={async () => {
						try {
							await removeSkill(dialog.remove)
						} catch (failure) {
							throw new Error(plainErrorText(failure, 'remove the skill'))
						}
					}}
					onClose={() => setDialog(undefined)}
				/>
			)}
		</>
	)

	return (
		<section
			ref={root}
			id="customize-content"
			className="customize-page"
			aria-label="Customize"
			tabIndex={-1}
		>
			<div className="customize-content">
				{tab === 'skills' && upload ? (
					<UploadSkillPage
						api={api}
						projectId={projectId}
						onBack={() => setUpload(false)}
						onDone={() => {
							setUpload(false)
							skills.reload()
						}}
					/>
				) : tab === 'plugins' && uploadPlugin ? (
					<UploadPluginPage
						api={api}
						projectId={projectId}
						onBack={() => setUploadPlugin(false)}
						onDone={() => setUploadPlugin(false)}
					/>
				) : (
					(detail ?? (
						<>
							<h1 className="customize-title">Customize</h1>
							<Tabs.Root value={tab} onValueChange={(value) => change(value as CustomizeTab)}>
								<CustomizeHeader
									tab={tab}
									onTab={change}
									query={query}
									onQuery={setQuery}
									sort={sort}
									onSort={setSort}
									add={add}
									searchLabel={searchLabel}
									beside={
										tab === 'plugins' && marketCount > 0 ? (
											<fieldset className="customize-tabs customize-view" aria-label="Plugins view">
												{(['yours', 'discover'] as const).map((id) => (
													<button
														key={id}
														type="button"
														className="customize-tab"
														data-active={(id === 'discover') === discovering || undefined}
														aria-pressed={(id === 'discover') === discovering}
														onClick={() => setPluginView(id)}
													>
														{id === 'yours' ? 'Yours' : 'Discover'}
													</button>
												))}
											</fieldset>
										) : undefined
									}
								/>
								<Tabs.Panel value="skills" className="customize-panel">
									{skills.error && !rows && <p className="customize-error">{skills.error}</p>}
									{!rows && !skills.error && <p className="customize-muted">Reading the skills…</p>}
									{rows && groups.length > 0 && (
										<SkillsList
											groups={groups}
											now={now}
											onOpen={(name) => {
												setSkillTab('overview')
												setSkillName(name)
											}}
											onToggle={(row, on) => void toggleSkill(row, on)}
											onRemove={canManage ? (row) => openDialog({ remove: row }) : undefined}
										/>
									)}
									{rows && groups.length === 0 && (
										<SkillsEmpty onCreate={onCreateSkill} searching={query.trim() !== ''} />
									)}
								</Tabs.Panel>
								<Tabs.Panel value="connectors" className="customize-panel">
									{servers.error && <p className="customize-error">{servers.error}</p>}
									<ConnectorsTable
										rows={connectors}
										approving={servers.approving}
										onOpen={onOpenConnector}
										onApprove={() => void servers.approve()}
										onAdd={onAddConnector}
										searching={query.trim() !== ''}
									/>
								</Tabs.Panel>
								<Tabs.Panel value="plugins" className="customize-panel">
									{view?.notice && <p className="customize-note">{view.notice}</p>}
									{view && !view.live && !view.notice && !disabled && (
										<p className="customize-note">
											Open a conversation to enable or disable plugins.
										</p>
									)}
									{view?.live && !view.canChange && (
										<p className="customize-note">
											Finish the active work before changing plugins.
										</p>
									)}
									{inventory.error && (
										<p className="customize-error" role="alert">
											{inventory.error}
										</p>
									)}
									{discovering && markets.view ? (
										<DiscoverGrid
											view={markets.view}
											available={markets.available}
											query={query}
											onAdd={(entry) => openDialog({ install: { id: entry.id, name: entry.name } })}
										/>
									) : (
										<>
											{!disabled && view && orderedPlugins.length > 0 ? (
												<PluginsList
													plugins={orderedPlugins}
													view={view}
													inventory={inventory}
													now={now}
													row={rowActions}
													onOpen={(entry: ComposerPlugin) => {
														inventory.clearError()
														setPluginTab('overview')
														setPluginKey(`${entry.scope}:${entry.name}`)
													}}
												/>
											) : !loading && (disabled || view) ? (
												<PluginsEmpty
													searching={query.trim() !== ''}
													disabled={Boolean(disabled)}
													onChooseSpace={onChooseSpace}
												/>
											) : (
												<p className="customize-muted">Loading plugins…</p>
											)}
											{markets.view && marketCount > 0 && query.trim() === '' && (
												<MarketplacesList
													view={markets.view}
													now={now}
													updating={pluginActions.updatingMarket}
													onUpdate={(name) => void pluginActions.updateMarket(name)}
													onRemove={(name) => openDialog({ removeMarketplace: name })}
												/>
											)}
										</>
									)}
								</Tabs.Panel>
							</Tabs.Root>
						</>
					))
				)}
			</div>
			{dialogs}
		</section>
	)
}
