import {
	ArrowUpIcon,
	ChevronDownIcon,
	FileDiffIcon,
	FolderIcon,
	ListPlusIcon,
	ListTodoIcon,
	SearchIcon,
	SquareIcon,
} from 'lucide-react'
import { type RefObject, useLayoutEffect, useRef } from 'react'
import type { PermissionView, ProviderView, QueuedMessageView } from '../shared/protocol.js'
import { ComposerApproval } from './composer-approval.js'
import { ComposerControl } from './composer-control.js'
import { ComposerSurface } from './composer-surface.js'
import { type ModelChoice, ModelPicker } from './model-picker.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import { Textarea } from './ui/textarea.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'

export function Composer({
	inputRef,
	draft,
	onDraftChange,
	providers,
	connected,
	providersLoading = false,
	choice,
	onChoiceChange,
	running,
	sending,
	queued,
	queuedItems,
	editingQueued,
	onSend,
	onStop,
	onEditQueued,
	onRemoveQueued,
	projectName,
	projectPath,
	onOpenProject,
	empty,
	permissions,
	onApproval,
}: {
	inputRef: RefObject<HTMLTextAreaElement | null>
	draft: string
	onDraftChange: (draft: string) => void
	providers: ProviderView
	connected: boolean
	providersLoading?: boolean
	choice: ModelChoice
	onChoiceChange: (choice: ModelChoice) => void
	running: boolean
	sending: boolean
	queued: string[]
	queuedItems: QueuedMessageView[]
	editingQueued: boolean
	onSend: () => void
	onStop: () => void
	onEditQueued: (itemId?: string) => void
	onRemoveQueued: (itemId: string) => void
	projectName: string
	projectPath: string
	onOpenProject: () => void
	empty: boolean
	permissions: PermissionView[]
	onApproval: (permission: PermissionView, approved: boolean) => void
}) {
	const overlay = useRef<HTMLDivElement>(null)
	const previous = useRef<{ top: number; empty: boolean } | null>(null)
	useLayoutEffect(() => {
		const node = overlay.current
		const stage = node?.parentElement
		if (!node || !stage) return
		const update = () =>
			stage.style.setProperty(
				'--composer-height',
				`${empty ? 0 : node.getBoundingClientRect().height}px`,
			)
		const stack = node.querySelector<HTMLElement>('[data-chat-composer-stack]')
		const nextTop = stack?.getBoundingClientRect().top
		let transition: Animation | undefined
		if (
			stack &&
			nextTop !== undefined &&
			previous.current &&
			previous.current.empty !== empty &&
			!window.matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			transition = stack.animate(
				[
					{ transform: `translateY(${previous.current.top - nextTop}px)` },
					{ transform: 'translateY(0px)' },
				],
				{ duration: 220, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
			)
			transition.id = 'namzu-composer-transition'
		}
		if (nextTop !== undefined) previous.current = { top: nextTop, empty }
		const observer = new ResizeObserver(update)
		observer.observe(node)
		update()
		return () => {
			observer.disconnect()
			transition?.cancel()
		}
	}, [empty])
	return (
		<div
			ref={overlay}
			data-chat-composer-overlay
			className={
				empty
					? 'composer-wrap pointer-events-none absolute inset-0 z-20 flex items-center'
					: 'composer-wrap pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2'
			}
		>
			<div className="w-full ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)">
				<div
					data-chat-composer-stack
					className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-max-width)"
				>
					{empty && (
						<div className="absolute inset-x-0 bottom-full pb-8">
							<h1 className="text-center text-2xl font-normal tracking-tight text-foreground sm:text-3xl">
								What would you like to work on?
							</h1>
						</div>
					)}
					{queued.length > 0 && (
						<div className="queue flex items-center gap-2 px-3 pb-2 text-xs text-muted-foreground">
							<ListPlusIcon className="size-3.5" />
							<Popover>
								<PopoverTrigger
									render={<Button variant="ghost-muted" size="xs" />}
									aria-label="Show queued messages"
								>
									{queued.length} queued
									<ChevronDownIcon className="size-3" />
								</PopoverTrigger>
								<PopoverPopup
									aria-label="Queued messages"
									align="start"
									side="top"
									width="lg"
									padding="compact"
									className="max-h-[min(24rem,var(--available-height))]"
								>
									<h2 className="text-sm font-medium">Next turns</h2>
									<p className="mt-1 text-xs text-muted-foreground">
										These messages start in order after the current turn finishes.
									</p>
									<ol className="mt-3 space-y-2">
										{queuedItems.map((item, index) => (
											<li
												key={item.id}
												data-queued-message-id={item.id}
												className="rounded-2xl border border-dashed border-border p-3"
											>
												<p className="whitespace-pre-wrap wrap-anywhere text-sm text-message-foreground">
													{item.prompt}
												</p>
												<div className="mt-2 flex items-center justify-end gap-1">
													<Button
														variant="ghost-muted"
														size="xs"
														aria-label={`Edit queued message ${index + 1}`}
														disabled={draft.length > 0 || editingQueued}
														title={draft.length > 0 ? 'Send or clear your draft first' : undefined}
														onClick={() => onEditQueued(item.id)}
													>
														Edit
													</Button>
													<Button
														variant="ghost-muted"
														size="xs"
														aria-label={`Remove queued message ${index + 1}`}
														onClick={() => onRemoveQueued(item.id)}
													>
														Remove
													</Button>
												</div>
											</li>
										))}
									</ol>
									{draft.length > 0 && (
										<p className="mt-2 text-xs text-muted-foreground">
											Send or clear your draft before editing a queued message.
										</p>
									)}
								</PopoverPopup>
							</Popover>
							<span className="min-w-0 flex-1 truncate">{queued[0]?.slice(0, 100)}</span>
							<Button
								variant="ghost-muted"
								size="xs"
								disabled={draft.length > 0 || editingQueued}
								title={draft.length > 0 ? 'Send or clear your draft first' : undefined}
								onClick={() => onEditQueued()}
							>
								Edit latest
							</Button>
						</div>
					)}
					<ComposerSurface.Shell contextStrip>
						{permissions[0] && (
							<ComposerApproval
								key={permissions[0].id}
								permission={permissions[0]}
								count={permissions.length}
								onRespond={onApproval}
							/>
						)}
						<ComposerSurface.Host>
							<ComposerSurface.Main>
								<div
									data-chat-composer-body
									data-resting={false}
									data-approval={permissions.length > 0}
									className="relative px-3 pt-3 pb-1 sm:px-4"
								>
									<Textarea
										unstyled
										className="composer-input"
										aria-label="Message Namzu"
										ref={inputRef}
										value={draft}
										maxLength={50000}
										disabled={editingQueued}
										placeholder="Ask Namzu anything"
										onChange={(event) => onDraftChange(event.target.value)}
										onKeyDown={(event) => {
											if (
												event.key === 'Enter' &&
												!event.shiftKey &&
												!event.nativeEvent.isComposing
											) {
												event.preventDefault()
												onSend()
											}
										}}
									/>
								</div>
								<div
									data-chat-composer-footer
									className="flex min-w-0 flex-nowrap items-center justify-end gap-2 overflow-visible px-3 pb-3 sm:px-4"
								>
									<div className="min-w-0 max-w-[calc(100%-5rem)]">
										<ModelPicker
											providers={providers}
											choice={choice}
											onChange={onChoiceChange}
											disabled={running || sending || !connected}
										/>
									</div>
									<div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
										{running && (
											<Tooltip>
												<TooltipTrigger
													render={
														<button
															type="button"
															className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-2xs inset-shadow-white/16 transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-black/8 active:shadow-none"
															aria-label="Stop turn"
															onClick={onStop}
														/>
													}
												>
													<SquareIcon className="size-3 fill-current" />
												</TooltipTrigger>
												<TooltipPopup>Stop · Esc</TooltipPopup>
											</Tooltip>
										)}
										{(!running || draft.trim()) && (
											<Tooltip>
												<TooltipTrigger
													render={
														<button
															type="button"
															className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-2xs enabled:inset-shadow-white/16 hover:scale-105 active:inset-shadow-black/8 active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover"
															aria-label={running ? 'Queue message' : 'Send message'}
															disabled={!draft.trim() || !choice.provider || sending || !connected}
															onClick={onSend}
														/>
													}
												>
													<ArrowUpIcon className="size-3.5" strokeWidth={1.8} />
												</TooltipTrigger>
												<TooltipPopup>
													{running ? 'Queue for the next turn' : 'Send message · Enter'}
												</TooltipPopup>
											</Tooltip>
										)}
									</div>
								</div>
							</ComposerSurface.Main>
						</ComposerSurface.Host>
						<ComposerSurface.ContextStrip>
							<ComposerControl
								size="xs"
								onClick={onOpenProject}
								aria-label="Choose project folder"
								className="min-w-0 max-w-full"
								title={projectPath}
							>
								<FolderIcon className="size-3.5" />
								<span className="truncate">{projectName}</span>
							</ComposerControl>
							<span className="ml-auto hidden pe-1 text-xs text-muted-foreground/50 sm:block">
								{running ? 'Working' : 'Local'}
							</span>
						</ComposerSurface.ContextStrip>
					</ComposerSurface.Shell>
					{empty && draft.length === 0 && providers.available.length > 0 && (
						<div className="starter-actions" aria-label="Ideas to get started">
							{[
								{ label: 'Explore this project', Icon: SearchIcon },
								{ label: 'Review a change', Icon: FileDiffIcon },
								{ label: 'Plan a task', Icon: ListTodoIcon },
							].map(({ label, Icon }) => (
								<button
									type="button"
									key={label}
									onClick={() => {
										onDraftChange(`${label}. `)
										inputRef.current?.focus()
									}}
								>
									<Icon aria-hidden="true" />
									<span>{label}</span>
								</button>
							))}
						</div>
					)}
					{!providersLoading && providers.available.length === 0 && (
						<p className="notice">
							Connect a provider in the Namzu terminal app, then reconnect this project.
						</p>
					)}
					<div aria-hidden className="h-4 sm:h-5" />
				</div>
			</div>
		</div>
	)
}
