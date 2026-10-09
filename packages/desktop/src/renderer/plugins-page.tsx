import { Tabs } from '@base-ui/react/tabs'
import { useEffect, useRef, useState } from 'react'
import {
	type ComposerPlugin,
	type ComposerPluginInventory,
	type ComposerPublicPlugin,
	type PluginCollection,
	type PluginInventoryProps,
	PluginInventoryRow,
	type PluginSelection,
	usePluginInventory,
} from './composer-plugins.js'
import {
	LoaderCircleIcon,
	PuzzleFilledIcon,
	PuzzleIcon,
	RefreshIcon,
	SearchIcon,
	XIcon,
} from './icons.js'
import { PluginDetails } from './plugin-details.js'
import { foldedIncludes } from './text-fold.js'
import { Button } from './ui/button.js'
import './plugins-page.css'

export interface PluginsPageProps extends PluginInventoryProps {
	onLoad: () => void
	onChooseSpace: () => void
	collection: PluginCollection
	onCollectionChange: (collection: PluginCollection) => void
	selected?: PluginSelection
	onOpenPlugin: (
		plugin: ComposerPlugin | ComposerPublicPlugin,
		collection: PluginCollection,
	) => void
	onTryPlugin: (plugin: ComposerPlugin) => void
	onBack: () => void
}

export function PluginsPage({
	onLoad,
	onChooseSpace,
	collection,
	onCollectionChange,
	selected,
	onOpenPlugin,
	onTryPlugin,
	onBack,
	...props
}: PluginsPageProps) {
	const { scope, view, loading, disabled } = props
	const inventory = usePluginInventory(props)
	const [query, setQuery] = useState('')
	const searchContext = useRef({ scope, collection })
	const loadedScope = useRef<string | undefined>(undefined)
	useEffect(() => {
		if (searchContext.current.scope === scope && searchContext.current.collection === collection)
			return
		searchContext.current = { scope, collection }
		setQuery('')
	}, [scope, collection])
	useEffect(() => {
		if (disabled) {
			loadedScope.current = undefined
			return
		}
		if (loadedScope.current !== scope) {
			loadedScope.current = scope
			onLoad()
		}
	}, [scope, disabled, onLoad])
	const term = query.trim()
	const entries: readonly (ComposerPlugin | ComposerPublicPlugin)[] | undefined =
		collection === 'public' ? view?.publicPlugins : view?.plugins
	const shown = (entries ?? []).filter(
		(plugin) =>
			!term || foldedIncludes(`${plugin.name} ${plugin.description} ${plugin.version}`, term),
	)
	const detail =
		!disabled && selected
			? selected.collection === 'public'
				? view?.publicPlugins?.find((plugin) => plugin.name === selected.name)
				: view?.plugins.find(
						(plugin) => plugin.scope === selected.scope && plugin.name === selected.name,
					)
			: undefined
	const detailKey = detail
		? `${scope}:${selected?.collection}:${selected?.scope}:${detail.name}`
		: ''
	const previousDetail = useRef(detailKey)
	useEffect(() => {
		if (previousDetail.current === detailKey) return
		previousDetail.current = detailKey
		inventory.clearError()
	}, [detailKey, inventory.clearError])
	useEffect(() => {
		if (selected && view && !loading && !detail) onBack()
	}, [selected, view, loading, detail, onBack])
	if (detail && view)
		return (
			<PluginDetails
				key={detailKey}
				plugin={detail}
				collection={selected?.collection ?? collection}
				view={view}
				inventory={{
					...inventory,
					error:
						'scope' in detail && inventory.errorPlugin === `${detail.scope}:${detail.name}`
							? inventory.error
							: undefined,
				}}
				onBack={onBack}
			/>
		)
	return (
		<section id="plugins-content" className="plugins-page" aria-label="Plugins" tabIndex={-1}>
			<div className="plugins-page-content">
				<header className="plugins-page-header">
					<div>
						<h1>Plugins</h1>
						<p>Connect plugins to work across your tools</p>
					</div>
					<div className="plugins-page-header-actions">
						<div className="plugins-page-search" data-disabled={disabled || undefined}>
							<SearchIcon aria-hidden="true" />
							<input
								id="installed-plugin-search"
								type="search"
								aria-label="Search plugins"
								placeholder="Search plugins"
								value={query}
								disabled={disabled}
								onChange={(event) => setQuery(event.target.value)}
							/>
							{query && (
								<Button
									variant="ghost-muted"
									size="icon-xs"
									aria-label="Clear plugin search"
									onClick={() => setQuery('')}
								>
									<XIcon />
								</Button>
							)}
						</div>
						<Button
							variant="ghost-muted"
							size="icon"
							aria-label="Refresh installed plugins"
							disabled={disabled || loading || Boolean(inventory.changing)}
							onClick={onLoad}
						>
							<RefreshIcon className={loading ? 'animate-spin' : undefined} />
						</Button>
					</div>
				</header>
				<Tabs.Root
					value={collection}
					onValueChange={(value) => {
						if (value !== 'public' && value !== 'personal') return
						onCollectionChange(value)
					}}
				>
					<Tabs.List className="plugins-page-tabs" aria-label="Plugin collections">
						<Tabs.Tab className="plugins-page-tab" value="public">
							Public
						</Tabs.Tab>
						<Tabs.Tab className="plugins-page-tab" value="personal">
							Personal
						</Tabs.Tab>
					</Tabs.List>
					<Tabs.Panel value={collection} className="plugins-page-tab-panel">
						{disabled ? (
							<div className="plugins-page-empty">
								<span className="plugins-page-empty-icon" aria-hidden="true">
									<PuzzleIcon />
								</span>
								<h2>Choose a space</h2>
								<p>Open a trusted project to see its installed plugins.</p>
								<Button variant="outline" onClick={onChooseSpace}>
									Choose a space
								</Button>
							</div>
						) : (
							<>
								{loading && (
									<output className="plugins-page-notice">
										<LoaderCircleIcon className="animate-spin" aria-hidden="true" />
										Loading plugins…
									</output>
								)}
								{(collection === 'public' ? view?.publicNotice : view?.notice) && (
									<div className="plugins-page-notice">
										<p>{collection === 'public' ? view?.publicNotice : view?.notice}</p>
										{collection === 'personal' && view?.plugins.length === 0 && (
											<Button
												variant="ghost-muted"
												size="sm"
												disabled={loading || Boolean(inventory.changing)}
												onClick={onLoad}
											>
												Try again
											</Button>
										)}
									</div>
								)}
								{collection === 'personal' && view?.live && !view.canChange && (
									<p className="plugins-page-notice">
										Finish the active work before changing plugins.
									</p>
								)}
								{collection === 'personal' && view && !view.live && !view.notice && (
									<p className="plugins-page-notice">
										Open a conversation to enable or disable plugins.
									</p>
								)}
								{collection === 'personal' && inventory.error && (
									<p className="plugins-page-error" role="alert">
										{inventory.error}
									</p>
								)}
								{view && shown.length > 0 ? (
									<section
										className="plugins-page-section"
										aria-label={`${collection === 'public' ? 'Public' : 'Personal'} plugin collection`}
									>
										<header className="plugins-page-section-heading">
											<h2>{collection === 'public' ? 'Public plugins' : 'Installed'}</h2>
											<span className="plugins-page-count">
												{shown.length} {shown.length === 1 ? 'plugin' : 'plugins'}
											</span>
										</header>
										<ul
											className="plugins-page-grid"
											aria-label={collection === 'public' ? 'Public plugins' : 'Installed plugins'}
										>
											{shown.map((plugin) => (
												<li
													key={`${scope}:${collection}:${'scope' in plugin ? plugin.scope : ''}:${plugin.name}`}
												>
													<PluginInventoryRow
														plugin={plugin}
														collection={collection}
														canTry={
															collection === 'personal' &&
															view.live &&
															'scope' in plugin &&
															plugin.status === 'enabled' &&
															!loading
														}
														onTry={() => {
															if ('scope' in plugin) onTryPlugin(plugin)
														}}
														onOpen={() => onOpenPlugin(plugin, collection)}
													/>
												</li>
											))}
										</ul>
									</section>
								) : !loading && (collection === 'public' || query || !view?.notice) ? (
									<div className="plugins-page-empty">
										<span className="plugins-page-empty-icon" aria-hidden="true">
											<PuzzleIcon />
										</span>
										<h2>
											{collection === 'public' && !entries
												? 'Public catalogue unavailable'
												: query
													? 'No matching plugins'
													: collection === 'public'
														? 'No public plugins'
														: 'No plugins installed'}
										</h2>
										<p>
											{collection === 'public' && !entries
												? 'A public plugin catalogue is not connected yet. Your installed plugins are in Personal.'
												: query
													? 'Try another search.'
													: collection === 'public'
														? 'Public plugins will appear here when available.'
														: 'Your installed plugins will appear here.'}
										</p>
										{query && entries && (
											<Button variant="ghost-muted" onClick={() => setQuery('')}>
												Clear search
											</Button>
										)}
									</div>
								) : null}
							</>
						)}
					</Tabs.Panel>
				</Tabs.Root>
			</div>
		</section>
	)
}

export function PluginsSidebar({
	view,
	loading,
	disabled,
	contextLabel,
	onChooseSpace,
	onOpenPlugin,
	onBack,
	onSearch,
	selected,
}: {
	view?: ComposerPluginInventory
	loading: boolean
	disabled: boolean
	contextLabel?: string
	onChooseSpace: () => void
	onOpenPlugin: (plugin: ComposerPlugin) => void
	onBack: () => void
	selected?: PluginSelection
	onSearch: () => void
}) {
	const plugins = disabled ? [] : (view?.plugins ?? [])
	return (
		<div className="plugins-sidebar-content">
			<header className="plugins-sidebar-header">
				<span>Customize</span>
				<Button
					variant="ghost-muted"
					size="icon-xs"
					aria-label="Search plugins"
					disabled={disabled}
					onClick={onSearch}
				>
					<SearchIcon />
				</Button>
			</header>
			<nav className="plugins-sidebar-navigation" aria-label="Customize navigation">
				<button type="button" aria-current={!selected ? 'page' : undefined} onClick={onBack}>
					<PuzzleFilledIcon aria-hidden="true" />
					<span>Plugins</span>
				</button>
			</nav>
			<section className="plugins-sidebar-installed" aria-label="Installed plugin names">
				<h2>Installed{view && !disabled && <span>{plugins.length}</span>}</h2>
				{contextLabel && !disabled && <p className="plugins-sidebar-context">{contextLabel}</p>}
				{loading && !disabled ? (
					<p className="plugins-sidebar-empty">Loading plugins…</p>
				) : plugins.length ? (
					<ul>
						{plugins.map((plugin) => (
							<li key={`${plugin.scope}:${plugin.name}`}>
								<button
									type="button"
									aria-current={
										selected?.collection === 'personal' &&
										selected.name === plugin.name &&
										selected.scope === plugin.scope
											? 'page'
											: undefined
									}
									onClick={() => onOpenPlugin(plugin)}
								>
									<PuzzleIcon aria-hidden="true" />
									<span title={plugin.name}>{plugin.name}</span>
								</button>
							</li>
						))}
					</ul>
				) : (
					<p className="plugins-sidebar-empty">
						{disabled
							? 'Choose a space to see your plugins.'
							: view?.notice
								? 'Plugin information is unavailable.'
								: 'No installed plugins yet.'}
					</p>
				)}
				{disabled && (
					<Button variant="ghost-muted" size="sm" onClick={onChooseSpace}>
						Choose a space
					</Button>
				)}
			</section>
		</div>
	)
}
