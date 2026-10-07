import type { DesktopEvent, PermissionResponse, PermissionView } from '../shared/protocol.js'

/**
 * Scripted permission requests for the live preview. `window.namzuPreviewApproval.raise(kind)` puts
 * one in front of the open conversation, and `answers` records what the card sent back, so a browser
 * run can check the whole round trip without a real agent.
 */
export type ApprovalScenario = 'edit' | 'create' | 'command' | 'none' | 'other' | 'long'

const routes = `import { Router } from 'express'
import { listUsers, createUser } from './users.js'

const router = Router()

router.get('/users', async (req, res) => {
	const users = await listUsers()
	res.json(users)
})

router.post('/users', async (req, res) => {
	const user = await createUser(req.body)
	res.status(201).json(user)
})

export default router
`
const routesAfter = `import { Router } from 'express'
import { listUsers, createUser } from './users.js'
import { requireSession } from '../auth/session.js'

const router = Router()

router.get('/users', requireSession, async (req, res) => {
	const page = Number(req.query.page ?? 1)
	const users = await listUsers({ page, pageSize: 50, includeDisabledAccountsInTheListing: false })
	res.json(users)
})

router.post('/users', requireSession, async (req, res) => {
	const user = await createUser(req.body)
	res.status(201).json(user)
})

export default router
`
const readme = `# Sample app

A small service with a users API.

## Run it

\`\`\`sh
pnpm dev
\`\`\`
`
const item = (i: number, doubled: boolean) => `export const item${i} = ${doubled ? i * 2 : i}`
const longBefore = `${Array.from({ length: 60 }, (_, i) => item(i, false)).join('\n')}\n`
const longAfter = `${Array.from({ length: 60 }, (_, i) => item(i, i % 4 === 0)).join('\n')}\n`

const root = '/home/arda/projects/sample-app'

function call(scenario: ApprovalScenario): PermissionView['calls'][number] {
	const id = `call-${scenario}-${Math.random().toString(36).slice(2, 8)}`
	switch (scenario) {
		case 'edit':
			return {
				id,
				name: 'edit',
				isDestructive: false,
				input: {
					path: 'src/server/routes.ts',
					old_string: "router.get('/users', async (req, res) => {",
					new_string: "router.get('/users', requireSession, async (req, res) => {",
				},
				preview: { path: `${root}/src/server/routes.ts`, before: routes, after: routesAfter },
			}
		case 'create':
			return {
				id,
				name: 'write',
				isDestructive: true,
				input: { path: 'README.md', content: readme },
				preview: { path: `${root}/README.md`, before: null, after: readme },
			}
		case 'command':
			return {
				id,
				name: 'bash',
				isDestructive: true,
				input: { command: 'pnpm --filter @sample/app test -- --run && git status --short' },
			}
		case 'none':
			return {
				id,
				name: 'edit',
				isDestructive: false,
				input: {
					path: 'src/server/routes.ts',
					old_string: "router.get('/users', async (req, res) => {",
					new_string: "router.get('/users', requireSession, async (req, res) => {",
				},
			}
		case 'long':
			return {
				id,
				name: 'edit',
				isDestructive: false,
				input: { path: 'src/constants.ts', old_string: 'x', new_string: 'y' },
				preview: { path: `${root}/src/constants.ts`, before: longBefore, after: longAfter },
			}
		default:
			return {
				id,
				name: 'web_fetch',
				isDestructive: false,
				input: {
					url: 'https://example.com/docs/changelog',
					maxBytes: 20000,
					followRedirects: true,
				},
			}
	}
}

export function createApprovalPreview(emit: (event: DesktopEvent) => void) {
	const answers: { requestId: string; response: PermissionResponse }[] = []
	let sequence = 0
	return {
		answers,
		raise(scenario: ApprovalScenario = 'edit', sessionId = 'sample-thread-1') {
			const request: PermissionView = {
				id: `preview-approval-${++sequence}`,
				sessionId,
				projectId: 'sample-app',
				calls: [call(scenario)],
			}
			emit({ kind: 'permission', request })
			return request.id
		},
		answer(sessionId: string, requestId: string, response: PermissionResponse) {
			answers.push({ requestId, response })
			emit({ kind: 'permission-cleared', sessionId, requestId })
		},
	}
}
