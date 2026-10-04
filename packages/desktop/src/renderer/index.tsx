import React from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from './ui/tooltip.js'
import { WorkspaceHost } from './workspace-host.js'
import './style.css'

createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<TooltipProvider delay={250}>
			<WorkspaceHost />
		</TooltipProvider>
	</React.StrictMode>,
)
