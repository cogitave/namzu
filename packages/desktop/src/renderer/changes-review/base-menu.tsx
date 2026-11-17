import { Menu } from '@base-ui/react/menu'
import { useState } from 'react'
import type { ProjectCompareReply } from '../../shared/protocol.js'
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon } from '../icons.js'
import {
	type BaseContext,
	type ChangesBase,
	baseRows,
	chipLabel,
	matchBranches,
	matchCommits,
} from './base.js'
import { MenuLabel } from './menu-parts.js'

export type BranchesReply = Extract<ProjectCompareReply, { op: 'branches' }>
export type CommitsReply = Extract<ProjectCompareReply, { op: 'commits' }>

type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; value: T }

export function BaseMenu({
	base,
	context,
	branches,
	commits,
	onChoose,
	onOpenCompare,
}: {
	base: ChangesBase
	context: BaseContext
	branches: Load<BranchesReply>
	commits: Load<CommitsReply>
	onChoose: (base: ChangesBase) => void
	/** The "Compare against" list opened: read the branches and commits now. */
	onOpenCompare: () => void
}) {
	const label = chipLabel(base, context)
	const { rows, compare } = baseRows(base, context)
	const checked = rows.find((row) => row.checked)?.id
	const [query, setQuery] = useState('')
	const current = branches.state === 'ready' ? branches.value.current : null
	const hits =
		branches.state === 'ready'
			? matchBranches(branches.value.branches, query, [context.defaultBranch, current])
			: []
	const commitHits = commits.state === 'ready' ? matchCommits(commits.value.commits, query) : []
	const olderCommits =
		commits.state === 'ready' ? Math.max(0, commits.value.total - commits.value.commits.length) : 0
	const baseRef = base.kind === 'branch' ? base.ref : ''
	const commitSha = base.kind === 'commit' ? base.sha : ''
	return (
		<Menu.Root
			onOpenChange={(open) => {
				if (!open) setQuery('')
			}}
		>
			<Menu.Trigger className="changes-chip" aria-label={`Diff scope: ${label.text}`}>
				{label.from && label.to ? (
					<>
						<span className="changes-chip-side changes-chip-from">{label.from}</span>
						<ArrowRightIcon className="changes-chip-arrow" aria-hidden="true" />
						<span className="changes-chip-side changes-chip-to">{label.to}</span>
					</>
				) : (
					<span className="changes-chip-side changes-chip-only">{label.text}</span>
				)}
				<ChevronDownIcon className="changes-chip-chevron" aria-hidden="true" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner className="conversation-actions-positioner" align="start" sideOffset={6}>
					<Menu.Popup
						className="conversation-actions-popup changes-base-popup"
						aria-label="Diff scope"
					>
						<Menu.RadioGroup
							value={checked}
							onValueChange={(value) => {
								if (value === 'all') onChoose({ kind: 'all' })
								else if (value === 'uncommitted') onChoose({ kind: 'uncommitted' })
							}}
						>
							{rows.map((row) => (
								<Menu.RadioItem
									key={row.id}
									value={row.id}
									className="conversation-actions-item"
									closeOnClick
								>
									<MenuLabel hint={row.hint}>{row.label}</MenuLabel>
									<Menu.RadioItemIndicator>
										<CheckIcon aria-hidden="true" />
									</Menu.RadioItemIndicator>
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
						{compare && (
							<>
								<Menu.Separator className="conversation-actions-separator" />
								<Menu.SubmenuRoot onOpenChange={(open) => open && onOpenCompare()}>
									<Menu.SubmenuTrigger className="conversation-actions-item">
										<MenuLabel hint={base.kind === 'branch' ? base.ref : undefined}>
											Compare against
										</MenuLabel>
										<ChevronRightIcon className="conversation-actions-chevron" aria-hidden="true" />
									</Menu.SubmenuTrigger>
									<Menu.Portal>
										<Menu.Positioner
											className="conversation-actions-positioner"
											sideOffset={6}
											alignOffset={-6}
										>
											<Menu.Popup
												className="conversation-actions-popup changes-compare-popup"
												aria-label="Compare against"
											>
												<input
													className="changes-menu-search"
													type="text"
													value={query}
													placeholder="Search branches and commits"
													aria-label="Search branches and commits"
													spellCheck={false}
													autoComplete="off"
													// biome-ignore lint/a11y/noAutofocus: the search is why the list was opened.
													autoFocus
													onChange={(event) => setQuery(event.target.value)}
													onKeyDown={(event) => {
														// Typing here is not the menu's typeahead.
														if (event.key !== 'Escape' && event.key !== 'ArrowLeft')
															event.stopPropagation()
													}}
												/>
												<div className="changes-compare-list">
													<p className="changes-menu-caption">Branches</p>
													{branches.state === 'loading' ? (
														<p className="changes-menu-note">Loading branches…</p>
													) : branches.state === 'error' ? (
														<p className="changes-menu-note">Couldn’t load branches</p>
													) : hits.length === 0 ? (
														<p className="changes-menu-note">No branches match</p>
													) : (
														<Menu.RadioGroup
															value={baseRef}
															onValueChange={(ref) => onChoose({ kind: 'branch', ref })}
														>
															{hits.map((branch) => (
																<Menu.RadioItem
																	key={branch.name}
																	value={branch.name}
																	className="conversation-actions-item"
																	closeOnClick
																>
																	<MenuLabel
																		hint={
																			branch.name === context.defaultBranch ? 'default' : undefined
																		}
																	>
																		{branch.name}
																	</MenuLabel>
																	<Menu.RadioItemIndicator>
																		<CheckIcon aria-hidden="true" />
																	</Menu.RadioItemIndicator>
																</Menu.RadioItem>
															))}
														</Menu.RadioGroup>
													)}
													<Menu.Separator className="conversation-actions-separator" />
													<p className="changes-menu-caption">Commits</p>
													{commits.state === 'loading' ? (
														<p className="changes-menu-note">Loading commits…</p>
													) : commits.state === 'error' ? (
														<p className="changes-menu-note">Couldn’t load commits</p>
													) : commitHits.length === 0 ? (
														<p className="changes-menu-note">
															{query.trim()
																? `No match in the newest ${commits.value.commits.length} commits`
																: 'No commits yet'}
														</p>
													) : (
														<Menu.RadioGroup
															value={commitSha}
															onValueChange={(sha) =>
																onChoose({
																	kind: 'commit',
																	sha,
																	subject:
																		commits.state === 'ready'
																			? commits.value.commits.find((entry) => entry.sha === sha)
																					?.subject
																			: undefined,
																})
															}
														>
															{commitHits.map((commit) => (
																<Menu.RadioItem
																	key={commit.sha}
																	value={commit.sha}
																	className="conversation-actions-item"
																	closeOnClick
																>
																	<MenuLabel hint={commit.short}>
																		{commit.subject || '(no message)'}
																	</MenuLabel>
																	<Menu.RadioItemIndicator>
																		<CheckIcon aria-hidden="true" />
																	</Menu.RadioItemIndicator>
																</Menu.RadioItem>
															))}
														</Menu.RadioGroup>
													)}
													{olderCommits > 0 && (
														<p className="changes-menu-note">
															{olderCommits} older commits not shown
														</p>
													)}
												</div>
											</Menu.Popup>
										</Menu.Positioner>
									</Menu.Portal>
								</Menu.SubmenuRoot>
							</>
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}
