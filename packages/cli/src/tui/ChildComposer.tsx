import { Box, Text } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Composer, type ComposerDraft } from './Composer.js'
import { truncateChoiceText } from './terminal-choice-text.js'
import { theme } from './theme.js'

export const CHILD_COMPOSER_ROWS = 8
export const CHILD_MESSAGE_MAX_LENGTH = 16_000

export function childComposerRows(terminalRows: number): number {
	return terminalRows < 24 ? 5 : CHILD_COMPOSER_ROWS
}

export interface ChildMessageAdmission {
	readonly kind: 'queued' | 'started'
	readonly taskId: string
	readonly state?: string
	readonly auditWarning?: string
}

/** The selected child has its own draft; submitting it never sends a parent prompt. */
export function ChildComposer({
	title,
	focused,
	hidden = false,
	columns,
	rows = CHILD_COMPOSER_ROWS,
	draft,
	onDraftChange,
	onSubmit,
}: {
	readonly title: string
	readonly focused: boolean
	readonly hidden?: boolean
	readonly columns: number
	readonly rows?: number
	readonly draft?: Omit<ComposerDraft, 'token'>
	readonly onDraftChange: (draft: Omit<ComposerDraft, 'token'>) => void
	readonly onSubmit: (text: string) => Promise<ChildMessageAdmission>
}) {
	const [restore, setRestore] = useState<ComposerDraft | null>(() =>
		draft ? { ...draft, token: 1 } : null,
	)
	const restoreToken = useRef(1)
	const pending = useRef(false)
	const lifetime = useRef({ active: true })
	const [sending, setSending] = useState(false)
	const [notice, setNotice] = useState<string | null>(null)
	useEffect(() => {
		const owner = lifetime.current
		owner.active = true
		return () => {
			owner.active = false
		}
	}, [])
	const submit = useCallback(
		(text: string, attachments?: ComposerDraft['attachments']) => {
			if (pending.current) return
			const submitted = text.trim()
			const restoreRejected = (reason: string) => {
				setNotice(reason)
				setRestore({
					text,
					...(attachments?.length ? { attachments } : {}),
					token: ++restoreToken.current,
				})
			}
			if (!submitted || submitted.length > CHILD_MESSAGE_MAX_LENGTH) {
				restoreRejected(`Enter a message of 1–${CHILD_MESSAGE_MAX_LENGTH} characters.`)
				return
			}
			if (attachments?.length) {
				restoreRejected('Messages to a child accept text only.')
				return
			}
			pending.current = true
			setSending(true)
			setNotice('Sending to this child…')
			const owner = lifetime.current
			void (async () => {
				try {
					const receipt = await onSubmit(submitted)
					if (!owner.active) return
					const label =
						receipt.kind === 'queued'
							? 'Message queued for the child’s next safe boundary.'
							: `New task accepted${receipt.state ? ` · ${receipt.state}` : ''}.`
					setNotice(receipt.auditWarning ? `${label} ${receipt.auditWarning}` : label)
				} catch (error) {
					if (!owner.active) return
					restoreRejected(error instanceof Error ? error.message : String(error))
				} finally {
					pending.current = false
					if (owner.active) setSending(false)
				}
			})()
		},
		[onSubmit],
	)

	return (
		<Box
			flexDirection="column"
			display={hidden ? 'none' : 'flex'}
			height={rows}
			flexShrink={0}
			overflow="hidden"
			borderStyle="single"
			borderColor={focused ? theme.border.focus : theme.border.default}
			paddingX={1}
		>
			<Text color={theme.accent.user} bold wrap="truncate-end">
				{rows < CHILD_COMPOSER_ROWS && notice
					? truncateChoiceText(notice, Math.max(1, columns - 6))
					: `Message · ${truncateChoiceText(title, Math.max(1, columns - 14))}`}
			</Text>
			<Composer
				plainText
				placeholder={focused ? 'Message this child…' : 'Enter to message this child'}
				history={[]}
				disabled={!focused || sending}
				hidden={hidden}
				escapeInterrupts
				onSubmit={submit}
				onNotice={setNotice}
				onDraftChange={onDraftChange}
				draftToRestore={restore}
				onDraftRestored={(token) =>
					setRestore((current) => (current?.token === token ? null : current))
				}
			/>
			{rows >= CHILD_COMPOSER_ROWS ? (
				<Text color={theme.text.muted} wrap="truncate-end">
					{focused
						? 'enter send · tab scroll · esc agents'
						: 'enter message · ↑↓ scroll · q parent'}
				</Text>
			) : null}
			{notice && rows >= CHILD_COMPOSER_ROWS ? (
				<Text color={theme.text.secondary} wrap="truncate-end">
					{truncateChoiceText(notice, Math.max(1, columns - 6))}
				</Text>
			) : null}
		</Box>
	)
}
