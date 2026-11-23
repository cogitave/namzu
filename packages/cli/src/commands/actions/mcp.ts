import type { ActionFlag, ActionHelp } from '../action-help.js'

const SCOPE: ActionFlag = {
	flag: '-s, --scope <user|project>',
	description: 'Where to write (default user); a project server waits for namzu mcp approve.',
}

export const MCP_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['list'],
		summary: 'List the tool servers and whether each is usable.',
		example: 'namzu mcp list',
	},
	{
		path: ['get'],
		operands: '<name>',
		summary: 'Show one tool server’s effective settings, with secret values hidden.',
		example: 'namzu mcp get files',
	},
	{
		path: ['add'],
		operands: '<name> [url] [-- <command> [arguments...]]',
		summary:
			'Add a tool server: an HTTP address, or a command after --. "add json <name> <json>" takes one .mcp.json entry.',
		flags: [
			SCOPE,
			{ flag: '-t, --transport <stdio|http>', description: 'What kind of server (default stdio).' },
			{ flag: '--url <http-url>', description: 'The address of an HTTP server.' },
			{
				flag: '-e, --env <NAME=value>',
				description:
					'Environment for a command server; repeat. NAME=${OTHER} reads your environment.',
			},
			{
				flag: '-H, --header <"NAME: value">',
				description:
					'Header for an HTTP server; repeat. The value must be ${ENV_VAR} or Bearer ${ENV_VAR}.',
			},
		],
		example: 'namzu mcp add files -e ROOT=/tmp -- npx -y some-files-server',
	},
	{
		path: ['remove'],
		operands: '<name>',
		summary: 'Remove a tool server.',
		flags: [SCOPE],
		example: 'namzu mcp remove files -s project',
	},
	{
		path: ['approve'],
		operands: '[name...]',
		summary: 'Start this project’s .mcp.json servers (all when no name is given).',
		flags: [
			{
				flag: '--new-list',
				description:
					'Start a new approvals list when the old one cannot be read; the old one is kept.',
			},
		],
		example: 'namzu mcp approve files',
	},
	{
		path: ['test'],
		operands: '<name>',
		summary: 'Check the effective server and list its tools.',
		flags: [{ flag: '--trust', description: 'Trust this folder for this run only.' }],
		example: 'namzu mcp test files',
	},
	{
		path: ['login'],
		operands: '<name>',
		summary: 'Sign in to an HTTP tool server that asks for it.',
		flags: [
			{ flag: '--no-browser', description: 'Do not open a browser; print the address.' },
			{ flag: '--timeout <seconds>', description: 'Give up waiting after this long.' },
		],
		example: 'namzu mcp login files --no-browser',
	},
	{
		path: ['logout'],
		operands: '<name>',
		summary: 'Forget the sign-in for a tool server.',
		example: 'namzu mcp logout files',
	},
	{
		path: ['serve'],
		summary: 'Serve Namzu’s file and shell tools to another program over stdin and stdout.',
		flags: [
			{
				flag: '--permission-mode <mode>',
				description: 'The permission mode the served tools run under.',
			},
			{ flag: '--allowed-tools <list>', description: 'Tools that need no approval.' },
			{ flag: '--disallowed-tools <list>', description: 'Tools that are refused.' },
			{ flag: '--add-dir <path>', description: 'Another folder the tools may use.' },
			{ flag: '--trust', description: 'Trust this folder for this run only.' },
		],
		example: 'namzu mcp serve --permission-mode plan',
	},
]
