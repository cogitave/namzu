import { Tabs } from '@base-ui/react/tabs'
import { useEffect, useRef, useState } from 'react'
import {
	type FileTreeNode,
	NO_SKILLS,
	type SkillGroupModel,
	type SkillRowModel,
	fileTree,
	firstFile,
	isMarkdownPath,
	lastUsedWords,
	longUpdated,
	shortUpdated,
	skillChips,
	skillHasMenu,
	skillLocation,
	skillStateNote,
	skillSubline,
	skillUpdatedAt,
	withoutFrontMatter,
} from './customize-model.js'
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
import {
	ChevronDownIcon,
	ChevronRightIcon,
	CodeIcon,
	ConversationIcon,
	EyeIcon,
	FileIcon,
} from './icons.js'
import { MarkdownContent } from './message.js'
import { Switch } from './settings-row.js'
import { Button } from './ui/button.js'
import { useSkillFileText } from './use-customize-skills.js'

const toggleEntry = (skill: SkillRowModel, onToggle: (on: boolean) => void): MenuEntry => ({
	label: skill.state === 'off' ? 'Turn on' : 'Turn off',
	onSelect: () => onToggle(skill.state === 'off'),
})

/** The Skills tab: a group per place, a row per skill. */
export function SkillsList({
	groups,
	now,
	onOpen,
	onToggle,
}: {
	groups: readonly SkillGroupModel[]
	now: number
	onOpen: (name: string) => void
	onToggle: (skill: SkillRowModel, on: boolean) => void
}) {
	return (
		<div className="customize-groups">
			{groups.map((group) => (
				<section key={group.id} className="customize-group" aria-label={group.title}>
					<GroupHeading title={group.title} count={group.rows.length} />
					<ul className="customize-list">
						{group.rows.map((skill) => (
							<li
								key={skill.name}
								className="customize-row"
								data-off={skill.state === 'off' || undefined}
							>
								<button
									type="button"
									className="customize-row-main"
									aria-label={`Open ${skill.name}`}
									onClick={() => onOpen(skill.name)}
								>
									<Tile icon={FileIcon} />
									<span className="customize-row-copy">
										<span className="customize-row-title">
											<span className="customize-name" title={skill.name}>
												{skill.name}
											</span>
											{skillChips(skill).map((chip) => (
												<Chip key={chip}>{chip}</Chip>
											))}
										</span>
										<span className="customize-row-sub">{skillSubline(skill)}</span>
									</span>
									<span className="customize-row-time">
										{shortUpdated(skillUpdatedAt(skill), now)}
									</span>
								</button>
								{skillHasMenu(skill) && (
									<MoreMenu
										label={`Actions for ${skill.name}`}
										items={[toggleEntry(skill, (on) => onToggle(skill, on))]}
									/>
								)}
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	)
}

export function SkillsEmpty({
	onCreate,
	searching,
}: { onCreate?: () => void; searching: boolean }) {
	return searching ? (
		<EmptyState>No skills match your search.</EmptyState>
	) : (
		<EmptyState
			action={
				onCreate && (
					<Button variant="outline" size="sm" onClick={onCreate}>
						Create with Namzu
					</Button>
				)
			}
		>
			{NO_SKILLS}
		</EmptyState>
	)
}

export type SkillDetailTab = 'overview' | 'contents'

/** One skill: its header with the switch, then Overview and Contents. */
export function SkillDetail({
	skill,
	now,
	tab,
	onTab,
	onBack,
	onToggle,
	onTry,
	switchDisabled,
	contents,
}: {
	skill: SkillRowModel
	now: number
	tab: SkillDetailTab
	onTab: (tab: SkillDetailTab) => void
	onBack: () => void
	onToggle: (on: boolean) => void
	onTry: () => void
	/** Why the switch cannot move, when it cannot. */
	switchDisabled?: string
	/** What the Contents tab shows; absent when the engine cannot read the folder. */
	contents?: React.ReactNode
}) {
	const on = skill.state !== 'off'
	const note = switchDisabled ?? skillStateNote(skill.state)
	const updated = longUpdated(skillUpdatedAt(skill), now)
	const showContents = Boolean(contents) && skill.fileCount > 0
	const shown: SkillDetailTab = showContents ? tab : 'overview'
	const menu = skillHasMenu(skill)
	return (
		<DetailFrame
			backLabel="Your skills"
			onBack={onBack}
			tile={<Tile icon={FileIcon} size={44} />}
			title={skill.name}
			subtitle={`${skill.plugin ? `plugin ${skill.plugin}` : skill.place}${updated ? ` · updated ${updated}` : ''}`}
			note={note}
			actions={
				<>
					<button type="button" className="customize-try" onClick={onTry}>
						<ConversationIcon aria-hidden="true" />
						Try in chat
					</button>
					{menu && (
						<MoreMenu label={`Actions for ${skill.name}`} items={[toggleEntry(skill, onToggle)]} />
					)}
					<Switch
						label={`Use ${skill.name}`}
						checked={on}
						disabled={Boolean(switchDisabled)}
						onChange={onToggle}
					/>
				</>
			}
		>
			<Tabs.Root value={shown} onValueChange={(value) => onTab(value as SkillDetailTab)}>
				<DetailTabs
					label="Skill sections"
					onChange={onTab}
					tabs={[
						{ id: 'overview', label: 'Overview' },
						...(showContents
							? [{ id: 'contents' as const, label: 'Contents', count: skill.fileCount }]
							: []),
					]}
				/>
				<Tabs.Panel value="overview" className="customize-panel">
					<div className="customize-overview">
						<div className="customize-overview-main">
							<dl className="customize-stats">
								<div>
									<dt>Uses</dt>
									<dd>{skill.uses7d ?? '—'}</dd>
									<dd className="customize-stat-unit">runs · 7 days</dd>
								</div>
								<div>
									<dt>Last used</dt>
									<dd>{lastUsedWords(skill.lastUsedAt, now)}</dd>
									<dd className="customize-stat-unit">by you</dd>
								</div>
							</dl>
							<h3 className="customize-label">Description</h3>
							<p className="customize-description">{skill.description || '—'}</p>
						</div>
						<aside className="customize-card" aria-label="Location">
							<h3 className="customize-label">Location</h3>
							<p className="customize-card-value">{skillLocation(skill)}</p>
						</aside>
					</div>
				</Tabs.Panel>
				{showContents && (
					<Tabs.Panel value="contents" className="customize-panel">
						{contents}
					</Tabs.Panel>
				)}
			</Tabs.Root>
		</DetailFrame>
	)
}

function TreeNode({
	node,
	closed,
	selected,
	onSelect,
	onFold,
	depth,
}: {
	node: FileTreeNode
	closed: ReadonlySet<string>
	selected?: string
	onSelect: (path: string) => void
	onFold: (path: string) => void
	depth: number
}) {
	const expanded = node.folder && !closed.has(node.path)
	return (
		<li>
			<button
				type="button"
				className="customize-tree-item"
				style={{ paddingInlineStart: 8 + depth * 14 }}
				aria-current={node.path === selected ? 'true' : undefined}
				aria-expanded={node.folder ? expanded : undefined}
				onClick={() => (node.folder ? onFold(node.path) : onSelect(node.path))}
			>
				{node.folder ? (
					expanded ? (
						<ChevronDownIcon aria-hidden="true" />
					) : (
						<ChevronRightIcon aria-hidden="true" />
					)
				) : (
					<FileIcon aria-hidden="true" />
				)}
				<span title={node.path}>{node.name}</span>
			</button>
			{expanded && (
				<ul>
					{node.children.map((child) => (
						<TreeNode
							key={child.path}
							node={child}
							closed={closed}
							selected={selected}
							onSelect={onSelect}
							onFold={onFold}
							depth={depth + 1}
						/>
					))}
				</ul>
			)}
		</li>
	)
}

/** The file tree and the viewer: read-only. */
export function SkillContentsView({
	files,
	error,
	path,
	onPath,
	text,
	textError,
	truncated,
}: {
	files?: readonly { path: string; size: number }[]
	error?: string
	path?: string
	onPath: (path: string) => void
	text?: string
	textError?: string
	truncated?: boolean
}) {
	const [source, setSource] = useState(false)
	const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
	if (error) return <p className="customize-error">{error}</p>
	if (!files) return <p className="customize-muted">Reading the files…</p>
	const tree = fileTree(files)
	const markdown = path ? isMarkdownPath(path) : false
	const fold = (folder: string) =>
		setClosed((all) => {
			const next = new Set(all)
			if (next.has(folder)) next.delete(folder)
			else next.add(folder)
			return next
		})
	return (
		<div className="customize-contents">
			<nav className="customize-tree" aria-label="Files">
				<ul>
					{tree.map((node) => (
						<TreeNode
							key={node.path}
							node={node}
							closed={closed}
							selected={path}
							onSelect={onPath}
							onFold={fold}
							depth={0}
						/>
					))}
				</ul>
			</nav>
			<div className="customize-viewer">
				<header className="customize-viewer-bar">
					<span title={path}>{path ?? ''}</span>
					{markdown && (
						<span className="customize-viewer-toggle">
							<button
								type="button"
								aria-label="Rendered"
								aria-pressed={!source}
								onClick={() => setSource(false)}
							>
								<EyeIcon />
							</button>
							<button
								type="button"
								aria-label="Source"
								aria-pressed={source}
								onClick={() => setSource(true)}
							>
								<CodeIcon />
							</button>
						</span>
					)}
				</header>
				<div className="customize-viewer-body">
					{textError ? (
						<p className="customize-error">{textError}</p>
					) : text === undefined ? (
						<p className="customize-muted">{path ? 'Reading the file…' : 'No files.'}</p>
					) : markdown && !source ? (
						<MarkdownContent text={withoutFrontMatter(text)} settled />
					) : (
						<pre className="customize-source">{text}</pre>
					)}
					{truncated && <p className="customize-muted">Showing the first part of this file.</p>}
				</div>
			</div>
		</div>
	)
}

/** The Contents tab with its own reads: the folder's files, and the one open. */
export function SkillContents({
	api,
	name,
	projectId,
	files,
	error,
}: {
	api: Parameters<typeof useSkillFileText>[0]
	name: string
	projectId?: string
	files?: readonly { path: string; size: number }[]
	error?: string
}) {
	const [chosen, setChosen] = useState<string>()
	const first = useRef(false)
	useEffect(() => {
		if (files && !first.current) {
			first.current = true
			setChosen((current) => current ?? firstFile(files))
		}
	}, [files])
	const path = chosen ?? (files ? firstFile(files) : undefined)
	const read = useSkillFileText(api, name, path, projectId)
	return (
		<SkillContentsView
			files={files}
			error={error}
			path={path}
			onPath={setChosen}
			text={read.text?.text}
			textError={read.error}
			truncated={read.text?.truncated}
		/>
	)
}
