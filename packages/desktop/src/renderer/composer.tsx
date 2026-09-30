import { ArrowUpIcon, ListPlusIcon, SquareIcon } from 'lucide-react'
import type { RefObject } from 'react'
import type { ProviderView } from '../shared/protocol.js'
import { ComposerSurface } from './composer-surface.js'
import { type ModelChoice, ModelPicker } from './model-picker.js'
import { Button } from './ui/button.js'
import { Textarea } from './ui/textarea.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'

export function Composer({
	inputRef,
	draft,
	onDraftChange,
	providers,
	choice,
	onChoiceChange,
	running,
	sending,
	queued,
	onSend,
	onStop,
	onEditQueued,
}: {
	inputRef: RefObject<HTMLTextAreaElement | null>
	draft: string
	onDraftChange: (draft: string) => void
	providers: ProviderView
	choice: ModelChoice
	onChoiceChange: (choice: ModelChoice) => void
	running: boolean
	sending: boolean
	queued: string[]
	onSend: () => void
	onStop: () => void
	onEditQueued: () => void
}) {
	return (
		<div className="composer-wrap">
			{queued.length > 0 && (
				<div className="queue">
					<ListPlusIcon className="size-3.5" />
					<span>
						{queued.length} queued · {queued[0]?.slice(0, 100)}
					</span>
					<Button variant="ghost-muted" size="xs" onClick={onEditQueued}>
						Edit latest
					</Button>
				</div>
			)}
			<ComposerSurface.Shell>
				<ComposerSurface.Host>
					<ComposerSurface.Main className="composer">
						<Textarea
							unstyled
							className="composer-input"
							aria-label="Message Namzu"
							ref={inputRef}
							value={draft}
							maxLength={50000}
							placeholder="Ask for changes, ask a question, or send a follow-up…"
							onChange={(event) => onDraftChange(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
									event.preventDefault()
									onSend()
								}
							}}
						/>
						<div className="composer-toolbar">
							<ModelPicker
								providers={providers}
								choice={choice}
								onChange={onChoiceChange}
								disabled={running || sending}
							/>
							<div className="send-controls">
								{running && (
									<Tooltip>
										<TooltipTrigger
											render={
												<Button
													variant="ghost-muted"
													size="icon-sm"
													aria-label="Stop turn"
													onClick={onStop}
												/>
											}
										>
											<SquareIcon className="size-3.5 fill-current" />
										</TooltipTrigger>
										<TooltipPopup>Stop · Esc</TooltipPopup>
									</Tooltip>
								)}
								<Tooltip>
									<TooltipTrigger
										render={
											<Button
												size="icon"
												className="send-button rounded-full"
												aria-label={running ? 'Queue message' : 'Send message'}
												disabled={!draft.trim() || !choice.provider || sending}
												onClick={onSend}
											/>
										}
									>
										{running ? <ListPlusIcon /> : <ArrowUpIcon />}
									</TooltipTrigger>
									<TooltipPopup>
										{running ? 'Queue for the next turn' : 'Send message · Enter'}
									</TooltipPopup>
								</Tooltip>
							</div>
						</div>
					</ComposerSurface.Main>
				</ComposerSurface.Host>
			</ComposerSurface.Shell>
			<div className="composer-hint">
				<span>
					{running
						? 'Messages wait for the next turn'
						: 'Enter to send · Shift + Enter for a new line'}
				</span>
			</div>
			{providers.available.length === 0 && (
				<p className="notice">Connect a provider in Namzu to start.</p>
			)}
		</div>
	)
}
