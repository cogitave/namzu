import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { useEffect, useState } from 'react'
import type { ProjectView } from '../shared/protocol.js'
import { ComposerControl, ComposerControlChevron } from './composer-control.js'
import { CheckIcon, FolderIcon } from './icons.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'

/** This chooser navigates existing ordinary contexts; it never grants project trust. */
export function ComposerProjectPicker({
	projectId,
	projectName,
	projectPath,
	projects,
	onSelectProject,
	onOpenProject,
}: {
	projectId: string
	projectName: string
	projectPath: string
	projects?: readonly ProjectView[]
	onSelectProject?: (project: ProjectView) => void
	onOpenProject: () => void
}) {
	const [open, setOpen] = useState(false)
	useEffect(() => {
		if (projectId) setOpen(false)
	}, [projectId])
	const choices = projects?.filter((project) => project.palId === undefined) ?? []
	const label = (
		<>
			<FolderIcon className="size-3.5" />
			<span className="truncate">{projectName}</span>
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
		return (
			<ComposerControl
				size="xs"
				aria-label="Choose project folder"
				className="composer-project-control"
				title={projectPath}
				onClick={onOpenProject}
			>
				{label}
			</ComposerControl>
		)
	}
	const select = (id: string) => {
		const project = choices.find((item) => item.id === id)
		if (!project) return
		setOpen(false)
		if (project.id !== projectId) onSelectProject(project)
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger render={control}>
				{label}
				<ComposerControlChevron size="xs" />
			</PopoverTrigger>
			<PopoverPopup
				side="top"
				align="start"
				width="md"
				padding="compact"
				aria-label="Project chooser"
			>
				<h2 className="mb-2 text-xs font-medium text-muted-foreground">Projects</h2>
				<RadioGroup
					value={projectId}
					onValueChange={select}
					aria-label="Available projects"
					className="composer-project-list"
				>
					{choices.map((project) => (
						<Radio.Root
							key={project.id}
							value={project.id}
							nativeButton
							render={<button type="button" />}
							className="composer-project-row"
							aria-label={project.name}
							data-project-status={project.status}
							data-project-trusted={project.trusted}
							onClick={(event) => {
								event.preventDefault()
								select(project.id)
							}}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault()
									select(project.id)
								}
							}}
						>
							<FolderIcon aria-hidden="true" />
							<span className="composer-project-name">
								<span title={project.path}>{project.name}</span>
								<small>
									{!project.trusted ? 'Approval required · ' : ''}
									{project.status === 'ready'
										? 'Connected'
										: project.status === 'connecting'
											? 'Connecting…'
											: 'Connection error'}
								</small>
							</span>
							<Radio.Indicator className="composer-project-check">
								<CheckIcon aria-hidden="true" />
							</Radio.Indicator>
						</Radio.Root>
					))}
				</RadioGroup>
				{choices.length === 0 && (
					<p className="py-2 text-xs text-muted-foreground">No projects open.</p>
				)}
				<div className="composer-project-actions">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setOpen(false)
							onOpenProject()
						}}
					>
						<FolderIcon aria-hidden="true" /> Open folder…
					</Button>
				</div>
			</PopoverPopup>
		</Popover>
	)
}
