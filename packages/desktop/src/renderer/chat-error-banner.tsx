import { useState } from 'react'
import type { SignInHelp } from './engine-setup.js'
import { CopyableCommand } from './harness-picker.js'
import { InfoIcon, XIcon } from './icons.js'
import { ensurePlain } from './plain-error.js'
import { Button } from './ui/button.js'

export function ChatErrorBanner({
	message,
	details,
	onDismiss,
	onRetry,
	retryLabel = 'Reconnect',
	signIn,
	onOpenTerminal,
}: {
	message: string
	/** The cleaned original of `message`; read only behind a Details toggle. */
	details?: string
	onDismiss?: () => void
	onRetry?: () => void
	retryLabel?: string
	/** The engine is installed but signed out: what to run, and where. */
	signIn?: SignInHelp
	/** Opens a terminal tab to run the sign-in command in; absent where no terminal can open. */
	onOpenTerminal?: () => void
}) {
	// Whatever reaches the banner is a sentence for a person: a raw error passed by mistake is
	// cleaned here, and its original moves behind Details.
	const plain = ensurePlain(message)
	const shown = plain.text
	const more = details ?? plain.details
	const [open, setOpen] = useState(false)
	return (
		<div className="flex w-full justify-center" role="alert">
			<div className="error-banner flex w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 backdrop-blur-md">
				<div className="flex min-w-0 flex-1 items-start gap-2 text-ui-base text-foreground">
					<InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-error-foreground" />
					<div className="min-w-0">
						<div className="whitespace-pre-wrap break-words font-medium">{shown}</div>
						{more && (
							<div className="mt-1">
								<button
									type="button"
									className="text-ui-sm text-muted-foreground underline-offset-2 hover:underline"
									aria-expanded={open}
									onClick={() => setOpen((value) => !value)}
								>
									Details
								</button>
								{open && (
									<p className="mt-1 break-words text-ui-sm text-muted-foreground">{more}</p>
								)}
							</div>
						)}
						{signIn && (
							<div className="mt-1 grid gap-1.5 text-muted-foreground">
								<p>
									Sign in to {signIn.name} in a terminal first. {signIn.hint} Then choose Retry
									setup.
								</p>
								<CopyableCommand command={signIn.command} label="Run this" />
							</div>
						)}
					</div>
				</div>
				{signIn && onOpenTerminal && (
					<Button variant="outline" size="sm" onClick={onOpenTerminal}>
						Open terminal
					</Button>
				)}
				{onRetry && (
					<Button variant="outline" size="sm" onClick={onRetry}>
						{retryLabel}
					</Button>
				)}
				{onDismiss && (
					<Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
						<XIcon />
					</Button>
				)}
			</div>
		</div>
	)
}
