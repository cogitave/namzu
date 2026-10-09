import { LoaderCircle } from 'lucide-react'
import { useId, useState } from 'react'
import type { EngineUpdateId } from '../shared/engine-update-protocol.js'
import { copyPlainText } from './copy-button.js'
import { engineRowView } from './engine-updates-model.js'
import { DownloadIcon } from './icons.js'
import { Button } from './ui/button.js'
import { useEngineUpdates } from './use-engine-updates.js'
import './engine-updates.css'

/** Where an update's terminal tab goes: the pane Settings is open in. */
export interface EngineUpdateTarget {
	groupId: string
	projectId?: string
	/** The terminal tab is open: leave the page so the output is what the person sees. */
	onStarted?: () => void
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
	const heading = useId()
	const [refused, setRefused] = useState<Partial<Record<EngineUpdateId, Refusal>>>({})
	const [copied, setCopied] = useState<EngineUpdateId>()
	if (!engines || engines.state.items.length === 0) return null
	const run = async (id: EngineUpdateId) => {
		if (!target) return
		setRefused((all) => ({ ...all, [id]: undefined }))
		const result = await engines.update(id, {
			groupId: target.groupId,
			projectId: target.projectId,
		})
		if (result.ok) target.onStarted?.()
		else
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
					const view = engineRowView(item)
					const refusal = refused[item.id]
					const command = refusal?.command ?? view.command
					return (
						<li key={item.id} id={`setting-engine-${item.id}`} data-tone={view.tone}>
							<div className="engine-update-copy">
								<div className="engine-update-heading">
									<h4>{view.title}</h4>
									<span className="engine-update-versions">{view.versions}</span>
								</div>
								<p className="engine-update-status" data-tone={view.tone}>
									{view.status}
								</p>
								{view.note && <p className="engine-update-note">{view.note}</p>}
								{command && view.action && (
									<p className="engine-update-command">
										{view.action === 'copy' ? 'Run: ' : 'Runs in a new terminal tab: '}
										<code>{command}</code>
									</p>
								)}
								{refusal && (
									<p role="alert" className="engine-update-refusal">
										{refusal.reason}
									</p>
								)}
							</div>
							<div className="engine-update-control">
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
