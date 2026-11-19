import React from 'react'
import { createRoot } from 'react-dom/client'
import { startInterfaceFont } from './interface-font.js'
import { TooltipProvider } from './ui/tooltip.js'
import { WorkspaceHost } from './workspace-host.js'
import './style.css'

startInterfaceFont()

createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<TooltipProvider delay={250}>
			<WorkspaceHost />
		</TooltipProvider>
	</React.StrictMode>,
)
