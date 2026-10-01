/* Adapted compact approval presentation; provenance: THIRD-PARTY-NOTICES.txt. */
import { ShieldAlertIcon } from 'lucide-react'
import type { PermissionView } from '../shared/protocol.js'
import { ComposerBanner } from './composer-banner.js'
import { Button } from './ui/button.js'

export function ComposerApproval({
	permission,
	count,
	onRespond,
}: {
	permission: PermissionView
	count: number
	onRespond: (permission: PermissionView, approved: boolean) => void
}) {
	const first = permission.calls[0]
	const input =
		first?.input && typeof first.input === 'object'
			? (first.input as Record<string, unknown>)
			: undefined
	const summary =
		typeof input?.command === 'string'
			? input.command
			: typeof input?.path === 'string'
				? `${first?.name}: ${input.path}`
				: (first?.name ?? 'Action approval')
	return (
		<ComposerBanner.Dock>
			<ComposerBanner.Column>
				<ComposerBanner.Attachment>
					<section aria-label="Tool approval">
						<ComposerBanner.Root variant="warning" density="spacious">
							<ComposerBanner.Row layout="approval">
								<ComposerBanner.Icon>
									<ShieldAlertIcon />
								</ComposerBanner.Icon>
								<ComposerBanner.Content>
									<span className="flex min-w-0 flex-1 flex-col items-start gap-1">
										<span className="flex w-full min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
											<span className="shrink-0 font-medium text-warning">
												Your approval is needed
											</span>
											{count > 1 && (
												<span className="ml-auto shrink-0 tabular-nums">1 / {count}</span>
											)}
										</span>
										<code
											tabIndex={0}
											data-approval-detail="complete"
											className="block max-h-20 w-full min-w-0 overflow-auto whitespace-pre text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
										>
											{summary}
										</code>
									</span>
								</ComposerBanner.Content>
								<ComposerBanner.Actions>
									<Button
										type="button"
										variant="outline"
										size="xs"
										onClick={() => onRespond(permission, false)}
									>
										Decline
									</Button>
									<Button type="button" size="xs" onClick={() => onRespond(permission, true)}>
										Allow once
									</Button>
								</ComposerBanner.Actions>
							</ComposerBanner.Row>
							<div className="min-w-0 ps-8 pt-2">
								<details className="approval-details min-w-0 flex-1 text-xs text-muted-foreground">
									<summary className="w-fit cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
										Review{' '}
										{permission.calls.length === 1
											? 'action details'
											: `all ${permission.calls.length} actions`}
										{permission.calls.some((call) => call.isDestructive) &&
											' · changes or removes data'}
									</summary>
									<div className="approval-full-details mt-2 max-h-40 overflow-auto rounded-lg border border-border bg-muted p-2">
										{permission.calls.map((call) => (
											<div key={call.id} className="mb-2 last:mb-0">
												<strong className="font-medium text-foreground">
													{call.name}
													{call.isDestructive ? ' · changes or removes data' : ''}
												</strong>
												<pre className="mt-1 whitespace-pre-wrap wrap-anywhere">
													{JSON.stringify(call.input, null, 2)}
												</pre>
											</div>
										))}
									</div>
								</details>
							</div>
							<p className="ps-8 pt-1 text-[11px] text-muted-foreground/70">
								{permission.calls.length > 1
									? `Applies once to this batch of ${permission.calls.length} actions.`
									: 'Applies once to this action.'}
							</p>
						</ComposerBanner.Root>
					</section>
				</ComposerBanner.Attachment>
			</ComposerBanner.Column>
		</ComposerBanner.Dock>
	)
}
