import { Box } from 'ink'
import type { ReactNode } from 'react'

import { theme } from './theme.js'

/** A single active rail. Keep the Box and children mounted when a prompt takes focus. */
export function ComposerFrame({
	focus,
	hidden = false,
	children,
}: {
	readonly focus: boolean
	readonly hidden?: boolean
	readonly children: ReactNode
}) {
	return (
		<Box
			flexDirection="column"
			{...(hidden ? {} : { borderStyle: 'single' as const })}
			borderTop={false}
			borderBottom={false}
			borderLeft={!hidden}
			borderRight={false}
			borderColor={focus ? theme.border.focus : theme.border.default}
			paddingY={hidden ? 0 : 1}
			marginTop={hidden ? 0 : 1}
		>
			{children}
		</Box>
	)
}
