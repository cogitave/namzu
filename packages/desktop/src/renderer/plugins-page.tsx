import { useEffect, useRef, useState } from 'react'
import {
	type ComposerPluginInventory,
	PluginInventoryCard,
	type PluginInventoryProps,
	usePluginInventory,
} from './composer-plugins.js'
import { LoaderCircleIcon, PuzzleFilledIcon, PuzzleIcon, SearchIcon, XIcon } from './icons.js'
import { Button } from './ui/button.js'
import './plugins-page.css'

export interface PluginsPageProps extends PluginInventoryProps {
	onLoad: () => void
	onChooseSpace: () => void
}

export function PluginsPage({ onLoad, onChooseSpace, ...props }: PluginsPageProps) {
	const { scope, view, loading, disabled, contextLabel } = props
	const inventory = usePluginInventory(props)
	const [query, setQuery] = useState('')
	const [filter, setFilter] = useState<'all' | 'project' | 'user'>('all')
	const filterScope = useRef(scope)
	const loadedScope = useRef<string | undefined>(undefined)
	useEffect(() => {
		if (filterScope.current === scope) return
		filterScope.current = scope
		setQuery('')
		setFilter('all')
	}, [scope])
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
	const term = query.trim().toLocaleLowerCase()
	const shown = (view?.plugins ?? []).filter(
		(plugin) =>
			(filter === 'all' || plugin.scope === filter) &&
			(!term ||
				`${plugin.name} ${plugin.description} ${plugin.version}`
					.toLocaleLowerCase()
					.includes(term)),
	)
	return (
		<section id="plugins-content" className="plugins-page" aria-label="Plugins" tabIndex={-1}>
			<div className="plugins-page-content">
				<header className="plugins-page-header">
					<div>
						<h1>Plugins</h1>
						<p>{contextLabel ? `Installed for ${contextLabel}` : 'Your installed plugins'}</p>
					</div>
					<div className="plugins-page-search" data-disabled={disabled || undefined}>
						<SearchIcon aria-hidden="true" />
						<input
							type="search"
							aria-label="Search installed plugins"
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
				</header>
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
						<div className="plugins-page-toolbar">
							<fieldset className="plugins-page-filters" aria-label="Filter plugins by scope">
								{(
									[
										{ value: 'all', label: 'All' },
										{ value: 'project', label: 'Project' },
										{ value: 'user', label: 'Personal' },
									] as const
								).map(({ value, label }) => (
									<Button
										key={value}
										variant="ghost-muted"
										size="sm"
										aria-pressed={filter === value}
										onClick={() => setFilter(value)}
									>
										{label}
									</Button>
								))}
							</fieldset>
							{view && (
								<span className="plugins-page-count">
									{shown.length} {shown.length === 1 ? 'plugin' : 'plugins'}
								</span>
							)}
						</div>
						{loading && (
							<output className="plugins-page-notice">
								<LoaderCircleIcon className="animate-spin" aria-hidden="true" />
								Loading plugins…
							</output>
						)}
						{view?.notice && (
							<div className="plugins-page-notice">
								<p>{view.notice}</p>
								{view.plugins.length === 0 && (
									<Button variant="ghost-muted" size="sm" disabled={loading} onClick={onLoad}>
										Try again
									</Button>
								)}
							</div>
						)}
						{view?.live && !view.canChange && (
							<p className="plugins-page-notice">Finish the active work before changing plugins.</p>
						)}
						{view && !view.live && !view.notice && (
							<p className="plugins-page-notice">
								Open a conversation to enable or disable plugins.
							</p>
						)}
						{inventory.error && (
							<p className="plugins-page-error" role="alert">
								{inventory.error}
							</p>
						)}
						{view && shown.length > 0 ? (
							<ul className="plugins-page-grid" aria-label="Installed plugins">
								{shown.map((plugin) => (
									<li key={`${plugin.scope}:${plugin.name}`}>
										<PluginInventoryCard plugin={plugin} view={view} inventory={inventory} page />
									</li>
								))}
							</ul>
						) : !loading && (query || filter !== 'all' || !view?.notice) ? (
							<div className="plugins-page-empty">
								<span className="plugins-page-empty-icon" aria-hidden="true">
									<PuzzleIcon />
								</span>
								<h2>
									{query || filter !== 'all' ? 'No matching plugins' : 'No plugins installed'}
								</h2>
								<p>
									{query || filter !== 'all'
										? 'Try another search or choose a different scope.'
										: 'Plugins installed for this project or your profile will appear here.'}
								</p>
								{(query || filter !== 'all') && (
									<Button
										variant="ghost-muted"
										onClick={() => {
											setQuery('')
											setFilter('all')
										}}
									>
										Clear filters
									</Button>
								)}
							</div>
						) : null}
					</>
				)}
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
}: {
	view?: ComposerPluginInventory
	loading: boolean
	disabled: boolean
	contextLabel?: string
	onChooseSpace: () => void
}) {
	const plugins = disabled ? [] : (view?.plugins ?? [])
	return (
		<div className="plugins-sidebar-content">
			<header className="plugins-sidebar-header">Customize</header>
			<nav className="plugins-sidebar-navigation" aria-label="Customize navigation">
				<button
					type="button"
					aria-current="page"
					onClick={() => document.getElementById('plugins-content')?.focus()}
				>
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
								<PuzzleIcon aria-hidden="true" />
								<span title={plugin.name}>{plugin.name}</span>
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
