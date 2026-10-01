import { useEffect, useRef } from 'react'
import type {
	ComposerPlugin,
	ComposerPluginInventory,
	ComposerPublicPlugin,
	usePluginInventory,
} from './composer-plugins.js'
import { ChevronRightIcon, LoaderCircleIcon, PuzzleIcon } from './icons.js'
import { Button } from './ui/button.js'
import './plugin-details.css'

export interface PluginDetailsProps {
	plugin: ComposerPlugin | ComposerPublicPlugin
	collection: 'public' | 'personal'
	view: ComposerPluginInventory
	inventory: ReturnType<typeof usePluginInventory>
	onBack: () => void
}

export function PluginDetails({ plugin, collection, view, inventory, onBack }: PluginDetailsProps) {
	const heading = useRef<HTMLHeadingElement>(null)
	useEffect(() => {
		heading.current?.focus({ preventScroll: true })
	}, [])
	const installed = collection === 'personal' && 'scope' in plugin ? plugin : undefined
	const changing = Boolean(
		installed && inventory.changing === `${installed.scope}:${installed.name}`,
	)
	const enabled = installed?.status === 'enabled'
	const status = installed
		? view.live
			? ({ enabled: 'Enabled', disabled: 'Disabled', installed: 'Installed', error: 'Unavailable' }[
					installed.status
				] ?? installed.status)
			: installed.status === 'error'
				? 'Unavailable'
				: 'Installed'
		: undefined
	const notice = collection === 'public' ? view.publicNotice : view.notice
	return (
		<section
			id="plugin-details-content"
			className="plugins-page plugin-details-page"
			aria-label={`${plugin.name} plugin details`}
			tabIndex={-1}
			onKeyDown={(event) => {
				if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing)
					return
				const target = event.target instanceof Element ? event.target : undefined
				if (target?.closest('[role="dialog"], [role="menu"], [data-slot="popover-popup"]')) return
				event.preventDefault()
				event.stopPropagation()
				onBack()
			}}
		>
			<nav className="plugin-details-breadcrumb" aria-label="Plugin breadcrumb">
				<Button variant="ghost-muted" size="sm" onClick={onBack}>
					Plugins
				</Button>
				<ChevronRightIcon aria-hidden="true" />
				<span aria-current="page" title={plugin.name}>
					{plugin.name}
				</span>
			</nav>
			<div className="plugin-details-body">
				<span className="plugin-details-icon" aria-hidden="true">
					<PuzzleIcon />
				</span>
				<header className="plugin-details-header">
					<div className="plugin-details-heading-copy">
						<h1 id="plugin-details-heading" ref={heading} tabIndex={-1}>
							{plugin.name}
						</h1>
						{plugin.description && (
							<p className="plugin-details-description">{plugin.description}</p>
						)}
					</div>
					{installed && view.live && (
						<Button
							variant="outline"
							size="sm"
							className="plugin-details-action"
							aria-label={`${enabled ? 'Disable' : 'Enable'} ${plugin.name}`}
							aria-busy={changing || undefined}
							disabled={!inventory.canChange(installed)}
							onClick={() => void inventory.change(installed)}
						>
							{changing && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
							{changing ? 'Changing…' : enabled ? 'Disable' : 'Enable'}
						</Button>
					)}
				</header>
				{notice && <p className="plugin-details-notice">{notice}</p>}
				{installed && view.live && !view.canChange && (
					<p className="plugin-details-notice">Finish the active work before changing plugins.</p>
				)}
				{installed && !view.live && !view.notice && (
					<p className="plugin-details-notice">Open a conversation to enable or disable plugins.</p>
				)}
				{installed && inventory.error && (
					<p className="plugin-details-error" role="alert">
						{inventory.error}
					</p>
				)}
				{(installed || plugin.version) && (
					<section
						className="plugin-details-information"
						aria-labelledby="plugin-information-heading"
					>
						<h2 id="plugin-information-heading">Information</h2>
						<dl>
							{installed && (
								<div>
									<dt>Installation</dt>
									<dd>{installed.scope === 'user' ? 'Personal' : 'Project'}</dd>
								</div>
							)}
							{plugin.version && (
								<div>
									<dt>Version</dt>
									<dd>{plugin.version}</dd>
								</div>
							)}
							{installed && (
								<div>
									<dt>{view.live ? 'Current status' : 'Status'}</dt>
									<dd>{status}</dd>
								</div>
							)}
							{installed && (
								<div>
									<dt>Starts next time</dt>
									<dd>
										{installed.startupEnabled === undefined
											? 'Saved setting unavailable'
											: installed.startupEnabled
												? 'Enabled'
												: 'Disabled'}
									</dd>
								</div>
							)}
						</dl>
						{installed?.startupError && (
							<div className="plugin-details-startup-error">
								<h3>Startup error</h3>
								<p>{installed.startupError}</p>
							</div>
						)}
					</section>
				)}
			</div>
		</section>
	)
}
