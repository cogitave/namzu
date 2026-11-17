import { cn } from '../lib/utils.js'

/**
 * A 30 by 16 switch to draw inside a menu row. The row is the control (a checkbox item that says
 * whether it is on); this only shows the state, so it takes no focus and no clicks of its own.
 */
function SwitchMark({ on, className }: { on: boolean; className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn('composer-switch', className)}
			data-slot="switch-mark"
			data-on={on || undefined}
		/>
	)
}

export { SwitchMark }
