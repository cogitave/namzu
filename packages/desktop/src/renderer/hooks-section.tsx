import { useState } from 'react'
import type { HooksReport } from '../shared/hooks-report.js'
import {
	EMPTY_HOOKS,
	OLD_ENGINE_HOOKS,
	type ProblemView,
	disableHooksValue,
	hooksListView,
	hooksNote,
	runHooksState,
	savedHooksNote,
	untrustedLine,
} from './hooks-view-model.js'
import { plainErrorText } from './plain-error.js'
import { Row, Switch } from './settings-row.js'
import type { ConfigSettingsControls } from './use-config-settings.js'
import type { HooksControls } from './use-hooks-view.js'

function Problem({ problem }: { problem: ProblemView }) {
	return (
		<p
			role={problem.severity === 'problem' && !problem.inactive ? 'alert' : undefined}
			className="hook-problem"
			data-severity={problem.severity}
		>
			<span className="hook-problem-kind">
				{problem.severity === 'problem' ? 'Not loaded' : 'Note'}
			</span>{' '}
			{problem.source}: {problem.text}
			{problem.inactive ? ' (not applied until the folder is trusted)' : ''}
		</p>
	)
}

/**
 * Settings ▸ Tools ▸ hooks: one switch, "Run hooks", and the read-only list of what runs by itself
 * for the open project (or the person's own settings when none is open). Every fact in the list is
 * the engine's; a hook's secrets are never in the answer, and nothing here starts anything.
 */
export function HooksRows({
	hooks,
	config,
	projectName,
	justSaved,
}: {
	hooks: HooksControls
	config: ConfigSettingsControls
	projectName?: string
	/** Starts as if the switch was just saved to this value (the view's own state sets it afterwards). */
	justSaved?: boolean
}) {
	const [saving, setSaving] = useState(false)
	const [failure, setFailure] = useState<string>()
	const [saved, setSaved] = useState<boolean | undefined>(justSaved)
	const view = hooks.read?.view
	const report: HooksReport | undefined = view?.report
	const descriptor = config.view?.descriptors.find((item) => item.path === 'disableHooks')
	const setting = config.view?.settings.find((item) => item.path === 'disableHooks')
	const state = runHooksState(report, setting)
	const canShowSwitch = Boolean(report || descriptor)
	// Until the engine says whether something else decides, the switch is left alone.
	const waiting = !report && hooks.supported && (hooks.read?.loading ?? true)
	const change = async (on: boolean) => {
		if (saving || state.locked) return
		setSaving(true)
		setFailure(undefined)
		try {
			const done = await config.change('disableHooks', disableHooksValue(on))
			if (done) {
				setSaved(on)
				hooks.reload()
			}
		} catch (error) {
			setFailure(plainErrorText(error, 'save the setting'))
		} finally {
			setSaving(false)
		}
	}
	const list = report ? hooksListView(report) : undefined
	const trust = report && !view?.own ? untrustedLine(report) : undefined
	return (
		<>
			{canShowSwitch && (
				<Row
					id="runHooks"
					label="Run hooks"
					description="Hooks are commands your settings, plugins, skills and agent files start by themselves at set moments. Switched off, the ones from your own and a project’s files do not run; the ones in your administrator’s file still do. A project that is open keeps what it started with: a change reaches it when Namzu next connects to it."
				>
					<div className="hooks-switch">
						<Switch
							label="Run hooks"
							checked={state.on}
							disabled={Boolean(state.locked) || saving || waiting}
							onChange={(next) => void change(next)}
						/>
						{state.locked && (
							<p className="settings-note hooks-locked" data-locked>
								{state.locked}
							</p>
						)}
						{saved !== undefined && !failure && (
							<p className="settings-note hooks-saved" data-pending-reconnect>
								{savedHooksNote(saved)}
							</p>
						)}
						{(failure ?? config.errors.disableHooks) && (
							<p role="alert" className="settings-error settings-config-error">
								{failure ?? config.errors.disableHooks}
							</p>
						)}
					</div>
				</Row>
			)}
			{hooks.supported && (
				<Row
					id="hooks"
					label="Hooks"
					description={hooksNote(view?.own ?? true, projectName)}
					stacked
				>
					<div className="hooks-view">
						{hooks.read?.loading && !view && <p className="settings-note">Reading the hooks…</p>}
						{hooks.read?.error && (
							<p role="alert" className="settings-error">
								{hooks.read.error}
							</p>
						)}
						{hooks.read?.unsupported && <p className="settings-note">{OLD_ENGINE_HOOKS}</p>}
						{trust && <p className="settings-note">{trust}</p>}
						{report?.error ? (
							<p role="alert" className="settings-error">
								The configuration could not be read: {report.error}
							</p>
						) : null}
						{list?.summary && <p className="settings-note">{list.summary}</p>}
						{list?.heldBack && <p className="settings-note">{list.heldBack}</p>}
						{list?.empty && !hooks.read?.error && <p className="settings-note">{EMPTY_HOOKS}</p>}
						{list?.groups.map((group) => (
							<section key={group.key} className="hook-group" aria-label={group.when}>
								<h4 className="hook-when">
									{group.when}
									{group.event && <span className="hook-event">{group.event}</span>}
								</h4>
								{group.hooks.length > 0 && (
									<ul className="hook-list">
										{group.hooks.map((hook) => (
											<li key={hook.id} className="hook" data-state={hook.state}>
												<div className="hook-main">
													<span className="hook-runs">
														{hook.kind && <span className="hook-kind">{hook.kind} </span>}
														{hook.runs}
													</span>
													{hook.facts.length > 0 && (
														<span className="hook-facts">{hook.facts.join(' · ')}</span>
													)}
													<span className="hook-source">
														{hook.source}. {hook.change}
													</span>
													{hook.why && <span className="hook-why">{hook.why}</span>}
													{hook.notes.map((note) => (
														<span key={note} className="hook-why">
															{note}
														</span>
													))}
												</div>
												<span className="settings-badge" data-tone={hook.state}>
													{hook.stateLabel}
												</span>
											</li>
										))}
									</ul>
								)}
								{group.problems.map((problem) => (
									<Problem key={`${problem.source}:${problem.text}`} problem={problem} />
								))}
							</section>
						))}
						{list && list.modules.length > 0 && (
							<section className="hook-group" aria-label="Plugin code">
								<h4 className="hook-when">Code a plugin runs</h4>
								<ul className="hook-list">
									{list.modules.map((module) => (
										<li key={module.id} className="hook" data-state={module.state}>
											<div className="hook-main">
												<span className="hook-runs">{module.module}</span>
												<span className="hook-source">
													Plugin {module.plugin}. {module.change}
												</span>
												{module.why && <span className="hook-why">{module.why}</span>}
											</div>
											<span className="settings-badge" data-tone={module.state}>
												{module.stateLabel}
											</span>
										</li>
									))}
								</ul>
							</section>
						)}
						{list && list.unplaced.length > 0 && (
							<div className="hook-group">
								{list.unplaced.map((problem) => (
									<Problem key={`${problem.source}:${problem.text}`} problem={problem} />
								))}
							</div>
						)}
						{list && list.unreadable > 0 && (
							<p className="settings-note">
								{list.unreadable === 1
									? 'One entry in the engine’s answer could not be read, so the list may be incomplete.'
									: `${list.unreadable} entries in the engine’s answer could not be read, so the list may be incomplete.`}
							</p>
						)}
					</div>
				</Row>
			)}
		</>
	)
}
