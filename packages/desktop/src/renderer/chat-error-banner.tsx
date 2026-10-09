import { InfoIcon, XIcon } from './icons.js'
import { Button } from './ui/button.js'

export function ChatErrorBanner({
	message,
	onDismiss,
	onRetry,
	retryLabel = 'Reconnect',
}: { message: string; onDismiss?: () => void; onRetry?: () => void; retryLabel?: string }) {
	return (
		<div className="flex w-full justify-center" role="alert">
			<div className="error-banner flex w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 backdrop-blur-md">
				<div className="flex min-w-0 flex-1 items-start gap-2 text-ui-base text-foreground">
					<InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-error-foreground" />
					<div className="min-w-0 whitespace-pre-wrap break-words font-medium">{message}</div>
				</div>
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
