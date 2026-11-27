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
	PluginDetail,
	type PluginDetailTab,
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
import { PencilIcon, PlusIcon, UploadIcon } from './icons.js'
import { notify } from './notify.js'
import { plainErrorText } from './plain-error.js'
import { foldedIncludes } from './text-fold.js'
import { useConfigSettings } from './use-config-settings.js'
import { useCustomizeSkills, useSkillFiles } from './use-customize-skills.js'
import { useMcpServers } from './use-mcp-servers.js'
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
	// A skill just made is selected once the list has read it.
	const [pendingSelect, setPendingSelect] = useState<string>()
	const [dialog, setDialog] = useState<'create' | 'connector' | { remove: SkillRowModel }>()
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
	const canManage = Boolean(rows) && !skills.basic && Boolean(api.stageSkills)
	const skillEntries: MenuEntry[] = [
		...(canManage
			? [
					{ label: 'Upload skill', icon: UploadIcon, onSelect: () => setUpload(true) },
					{ label: 'Create a skill', icon: PencilIcon, onSelect: () => openDialog('create') },
				]
			: []),
		{ label: 'Create with Namzu', icon: PlusIcon, onSelect: onCreateSkill },
	]
	const add: AddMenuModel | undefined =
		tab === 'skills'
			? { items: skillEntries }
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
			{typeof dialog === 'object' && (
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
									{!disabled && view && orderedPlugins.length > 0 ? (
										<PluginsList
											plugins={orderedPlugins}
											view={view}
											inventory={inventory}
											now={now}
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
