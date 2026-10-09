import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { useEffect, useState } from 'react'
import type { ProjectView } from '../shared/protocol.js'
import {
	ADD_PROJECT_LABEL,
	AddProjectMenu,
	START_FROM_SCRATCH_LABEL,
	USE_EXISTING_FOLDER_LABEL,
} from './add-project-menu.js'
import { ComposerControl, ComposerControlChevron } from './composer-control.js'
import { CheckIcon, FolderIcon, FolderPlusIcon, SearchIcon, XIcon } from './icons.js'
import { commitsOnKey, committableProject } from './picker-commit.js'
import { foldedIncludes } from './text-fold.js'
import { Button } from './ui/button.js'
import { Input } from './ui/input.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'

/** This chooser navigates existing ordinary contexts; it never grants project trust. */
export function ComposerProjectPicker({
	projectId,
	projectName,
	projectPath,
	projects,
	onSelectProject,
	onOpenProject,
	onCreateProject,
	onLeaveProject,
}: {
	projectId: string
	projectName: string
	projectPath: string
	projects?: readonly ProjectView[]
	onSelectProject?: (project: ProjectView) => void
	onOpenProject: () => void
	onCreateProject?: () => void
	onLeaveProject?: () => void
}) {
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	useEffect(() => {
		if (projectId) {
			setOpen(false)
			setQuery('')
		}
	}, [projectId])
	const choices = projects?.filter((project) => project.palId === undefined) ?? []
	const search = query.trim()
	const visible = choices.filter(
		(project) =>
			!project.isChat && (!search || foldedIncludes(`${project.name} ${project.path}`, search)),
	)
	const label = (
		<>
			<FolderIcon className="size-3.5" />
			<span className="truncate">
				{choices.find((project) => project.id === projectId)?.isChat ? 'No project' : projectName}
			</span>
		</>
	)
	const control = (
		<ComposerControl
			size="xs"
			aria-label="Choose project folder"
			className="composer-project-control"
			title={projectPath}
		/>
	)
	if (!projects || !onSelectProject) {
		const fallback = (
			<ComposerControl
				size="xs"
				aria-label={onCreateProject ? ADD_PROJECT_LABEL : 'Choose project folder'}
				className="composer-project-control"
				title={projectPath}
				onClick={onCreateProject ? undefined : onOpenProject}
			>
				{label}
			</ComposerControl>
		)
		return onCreateProject ? (
			<AddProjectMenu trigger={fallback} onCreate={onCreateProject} onOpen={onOpenProject} />
		) : (
			fallback
		)
	}
	const select = (id: string) => {
		const project = committableProject(choices, id)
		if (!project) return
		setOpen(false)
		setQuery('')
		if (project.id !== projectId) onSelectProject(project)
	}
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next)
				if (!next) setQuery('')
			}}
		>
			<PopoverTrigger render={control}>
				{label}
				<ComposerControlChevron size="xs" />
			</PopoverTrigger>
			<PopoverPopup
				side="top"
				align="start"
				padding="none"
				aria-label="Project chooser"
				className="composer-project-popup"
			>
				<div className="composer-project-search">
					<SearchIcon aria-hidden="true" />
					<Input
						nativeInput
						unstyled
						type="search"
						aria-label="Search projects"
						placeholder="Search projects"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</div>
				<RadioGroup
					value={projectId}
					// Arrow keys only move focus; a choice is committed by click, Enter or Space (a native click).
					onValueChange={() => {}}
					aria-label="Available projects"
					className="composer-project-list"
				>
					{visible.map((project) => (
						<Radio.Root
							key={project.id}
							value={project.id}
							nativeButton
							render={<button type="button" />}
							className="composer-project-row"
							aria-label={project.name}
							disabled={project.missing === true}
							data-project-missing={project.missing ? '' : undefined}
							data-project-status={project.status}
							data-project-trusted={project.trusted}
							onClick={(event) => {
								event.preventDefault()
								select(project.id)
							}}
							onKeyDown={(event) => {
								if (commitsOnKey(event.key)) {
									event.preventDefault()
									select(project.id)
								}
							}}
						>
							<FolderIcon aria-hidden="true" />
							<span className="composer-project-name">
								<span title={project.path}>{project.name}</span>
								{project.missing ? (
									<small>Folder not found</small>
								) : (
									(!project.trusted || project.status !== 'ready') && (
										<small>
											{!project.trusted ? 'Folder access required' : ''}
											{project.status !== 'ready' && (
												<>
													{!project.trusted ? ' · ' : ''}
													{project.status === 'connecting' ? 'Connecting…' : 'Connection error'}
												</>
											)}
										</small>
									)
								)}
							</span>
							<span className="composer-project-selection" aria-hidden="true">
								<Radio.Indicator className="composer-project-check">
									<CheckIcon />
								</Radio.Indicator>
							</span>
						</Radio.Root>
					))}
				</RadioGroup>
				{visible.length === 0 && (
					<p className="composer-project-empty">
						{search ? 'No matching projects.' : 'No projects open.'}
					</p>
				)}
				<div className="composer-project-actions">
					{onCreateProject && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setOpen(false)
								onCreateProject()
							}}
						>
							<FolderPlusIcon aria-hidden="true" /> {START_FROM_SCRATCH_LABEL}
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setOpen(false)
							onOpenProject()
						}}
					>
						<FolderIcon aria-hidden="true" /> {USE_EXISTING_FOLDER_LABEL}
					</Button>
					{onLeaveProject && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setOpen(false)
								setQuery('')
								onLeaveProject()
							}}
						>
							<XIcon aria-hidden="true" /> Don't work in a project
						</Button>
					)}
				</div>
			</PopoverPopup>
		</Popover>
	)
}
