import { LoaderCircle } from 'lucide-react'
import { useId, useState } from 'react'
import type { EngineUpdateId } from '../shared/engine-update-protocol.js'
import { copyPlainText } from './copy-button.js'
import { engineSetup, setupPlatform } from './engine-setup.js'
import { useSignedOutEngines } from './engine-sign-in.js'
import { engineRowView } from './engine-updates-model.js'
import { CopyableCommand } from './harness-picker.js'
import { DownloadIcon } from './icons.js'
import { Button } from './ui/button.js'
import { useEngineUpdates } from './use-engine-updates.js'
import './engine-updates.css'

/** Where an update's terminal tab goes: the pane Settings is open in. */
export interface EngineUpdateTarget {
	groupId: string
	projectId?: string
	/**
	 * The person asked to watch an update: bring its terminal tab to the front. An update never
	 * takes the person out of Settings by itself; its progress shows on the row.
	 */
	onShowOutput?: (tabId: string) => void
	/** Opens a plain terminal tab, where the person signs in to a signed-out engine. */
	onOpenTerminal?: () => void
}

interface Refusal {
	reason: string
	command?: string
}

/**
 * The three programs Namzu works beside: the two external engines and a standalone Namzu CLI. An
 * update runs only on a click, in a terminal tab the person can watch.
 */
export function EngineUpdateRows({ target }: { target?: EngineUpdateTarget }) {
	const engines = useEngineUpdates()
	const signedOut = useSignedOutEngines()
	const heading = useId()
	const [refused, setRefused] = useState<Partial<Record<EngineUpdateId, Refusal>>>({})
	const [copied, setCopied] = useState<EngineUpdateId>()
	const platform = setupPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent)
	if (!engines || engines.state.items.length === 0) return null
	const run = async (id: EngineUpdateId) => {
		if (!target) return
		setRefused((all) => ({ ...all, [id]: undefined }))
		const result = await engines.update(id, {
			groupId: target.groupId,
			projectId: target.projectId,
		})
		if (!result.ok)
			setRefused((all) => ({
				...all,
				[id]: { reason: result.reason, ...(result.command ? { command: result.command } : {}) },
			}))
	}
	const copy = (id: EngineUpdateId, command: string) => {
		void copyPlainText(command)
			.then(() => setCopied(id))
			.catch(() => setCopied(undefined))
	}
	return (
		<section className="engine-updates" aria-labelledby={heading}>
			<h3 id={heading} className="settings-subtitle">
				Programs Namzu works with
			</h3>
			<ul>
				{engines.state.items.map((item) => {
					const view = engineRowView(item, { signedOut: signedOut.has(item.id) })
					const refusal = refused[item.id]
					const command = refusal?.command ?? view.command
					return (
						<li key={item.id} id={`setting-engine-${item.id}`} data-tone={view.tone}>
							<div className="engine-update-copy">
								<div className="engine-update-heading">
									<h4>{view.title}</h4>
									{view.versions && <span className="engine-update-versions">{view.versions}</span>}
								</div>
								<p className="engine-update-status" data-tone={view.tone}>
									{view.status}
								</p>
								{view.note && <p className="engine-update-note">{view.note}</p>}
								{command && (view.action === 'copy' || refusal?.command) ? (
									<p className="engine-update-command">
										Run: <code>{command}</code>
									</p>
								) : (
									(view.action === 'update' || view.action === 'retry') && (
										<p className="engine-update-command">
											The update runs in a terminal tab you can watch.
										</p>
									)
								)}
								{view.busy && item.tabId && target?.onShowOutput && (
									<p className="engine-update-command">
										<button
											type="button"
											className="engine-update-link"
											onClick={() => item.tabId && target.onShowOutput?.(item.tabId)}
										>
											Show terminal output
										</button>
									</p>
								)}
								{item.missing && item.id !== 'namzu-cli' && (
									<div className="engine-update-install">
										{engineSetup(item.id, platform).install.map((step) => (
											<CopyableCommand
												key={step.command}
												command={step.command}
												label={step.label}
											/>
										))}
									</div>
								)}
								{refusal && (
									<p role="alert" className="engine-update-refusal">
										{refusal.reason}
									</p>
								)}
							</div>
							<div className="engine-update-control">
								{item.missing && (
									<Button
										size="sm"
										variant="outline"
										disabled={engines.state.checking}
										aria-label={`Check again for ${item.name}`}
										title="Looks for the program on this computer"
										onClick={() => engines.check()}
									>
										{engines.state.checking ? 'Checking…' : 'Check again'}
									</Button>
								)}
								{view.signedOut && target?.onOpenTerminal && (
									<Button
										size="sm"
										variant="outline"
										aria-label={`Open a terminal to sign in to ${item.name}`}
										onClick={() => target.onOpenTerminal?.()}
									>
										Open terminal
									</Button>
								)}
								{view.busy && (
									<Button size="sm" variant="outline" disabled aria-busy="true">
										<LoaderCircle
											aria-hidden="true"
											className="animate-spin motion-reduce:animate-none"
										/>
										Updating…
									</Button>
								)}
								{(view.action === 'update' || view.action === 'retry') && (
									<Button
										size="sm"
										disabled={!target}
										aria-label={`${view.action === 'retry' ? 'Try again' : 'Update'} ${item.name}`}
										onClick={() => void run(item.id)}
									>
										<DownloadIcon aria-hidden="true" />
										{view.action === 'retry' ? 'Try again' : 'Update'}
									</Button>
								)}
								{command && (view.action === 'copy' || refusal?.command) && (
									<Button
										size="sm"
										variant="outline"
										aria-label={`Copy the ${item.name} update command`}
										onClick={() => copy(item.id, command)}
									>
										{copied === item.id ? 'Copied' : 'Copy'}
									</Button>
								)}
							</div>
						</li>
					)
				})}
			</ul>
		</section>
	)
}
