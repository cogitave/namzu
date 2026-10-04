import { Tabs } from '@base-ui/react/tabs'
import type { ConversationView } from '../shared/protocol.js'
import { HarnessMark } from './harness-picker.js'
import { LoaderCircleIcon, PlusIcon, XIcon } from './icons.js'
import { Button } from './ui/button.js'
import { WordmarkInitial } from './wordmark.js'
import './conversation-tabs.css'

/** Views are peers; closing a tab does not stop or delete its owned conversation. */
export function ConversationTabs({
	tabs,
	active,
	busy,
	running,
	onSelect,
	onClose,
	onNew,
}: {
	tabs: readonly ConversationView[]
	active: string
	busy: boolean
	running: (id: string) => boolean
	onSelect: (view: ConversationView) => void
	onClose: (view: ConversationView) => void
	onNew: () => void
}) {
	return (
		<Tabs.Root
			className="conversation-tabs"
			value={active}
			onValueChange={(id) => {
				const view = tabs.find((tab) => tab.id === id)
				if (view && !busy) onSelect(view)
			}}
		>
			<Tabs.List className="conversation-tab-list" aria-label="Conversation tabs">
				{tabs.map((view) => (
					<div key={view.id} className="conversation-tab" data-active={active === view.id}>
						<Tabs.Tab
							value={view.id}
							disabled={busy}
							render={<Button variant="ghost" size="sm" />}
							className="conversation-tab-label"
							aria-label={`${view.harness === 'codex-cli' ? 'Codex CLI' : view.harness === 'claude-code' ? 'Claude Code' : 'Namzu'}: ${view.title}`}
						>
							<span className="conversation-tab-mark" aria-hidden="true">
								{running(view.id) ? (
									<LoaderCircleIcon className="size-3 animate-spin" />
								) : !view.harness || view.harness === 'namzu' ? (
									<WordmarkInitial />
								) : (
									<HarnessMark engine={view.harness} />
								)}
							</span>
							<span className="truncate" title={view.title}>
								{view.title}
							</span>
						</Tabs.Tab>
						<Button
							variant="ghost-muted"
							size="icon-xs"
							disabled={busy}
							aria-label={`Close tab ${view.title}`}
							onClick={() => onClose(view)}
						>
							<XIcon />
						</Button>
					</div>
				))}
			</Tabs.List>
			<Button
				variant="ghost-muted"
				size="icon-sm"
				aria-label="New conversation tab"
				disabled={busy}
				onClick={onNew}
			>
				<PlusIcon />
			</Button>
		</Tabs.Root>
	)
}
