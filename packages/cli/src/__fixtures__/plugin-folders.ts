import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** One file of a fixture plugin: its text, or `{ link }` for a symbolic link. */
export type FixtureFile = string | Buffer | { readonly link: string }

export interface FixtureSet {
	/** A scratch folder for the fixtures; the caller removes it. */
	readonly base: string
	/** A file outside every plugin folder, which links point at. */
	readonly outsideFile: string
	/** A file outside every plugin folder that is a valid `reconcile` skill. */
	readonly outsideSkill: string
	readonly outsideDir: string
	/** Write one plugin folder and return its path. */
	plugin(name: string, files: Record<string, FixtureFile>): string
}

export function createFixtureSet(): FixtureSet {
	const base = mkdtempSync(join(tmpdir(), 'namzu-plugin-validate-'))
	const outsideDir = join(base, 'outside')
	mkdirSync(outsideDir, { recursive: true })
	const outsideFile = join(outsideDir, 'secret.md')
	writeFileSync(outsideFile, '---\nname: secret\ndescription: outside\n---\nbody\n')
	const outsideSkill = join(outsideDir, 'reconcile-skill.md')
	writeFileSync(outsideSkill, SKILL_OK)
	return {
		base,
		outsideFile,
		outsideSkill,
		outsideDir,
		plugin(name, files) {
			const dir = join(base, 'plugins', name)
			mkdirSync(dir, { recursive: true })
			for (const [rel, content] of Object.entries(files)) {
				const target = join(dir, rel)
				mkdirSync(dirname(target), { recursive: true })
				if (typeof content === 'object' && 'link' in content) {
					symlinkSync(content.link, target)
				} else writeFileSync(target, content)
			}
			return dir
		},
	}
}

export function manifest(extra: Record<string, unknown> = {}, name = 'ledger'): string {
	return JSON.stringify({ name, version: '1.0.0', description: 'Ledger review', ...extra })
}

export const SKILL_OK = [
	'---',
	'name: reconcile',
	'description: Reconcile the ledger against the bank statement.',
	'---',
	'Compare each line and list the differences.',
	'',
].join('\n')

export const COMMAND_OK = [
	'---',
	'description: Audit one account',
	'argument-hint: [account]',
	'---',
	'Audit the account $ARGUMENTS and report.',
	'',
].join('\n')

export const AGENT_OK = [
	'---',
	'name: reviewer',
	'description: Reviews a ledger entry.',
	'tools: read, grep',
	'---',
	'You review ledger entries and cite the line.',
	'',
].join('\n')

export const TOOLS_JS = 'export const tools = []\n'
export const HOOKS_JS =
	"export const hooks = [{ event: 'turn_end', handler: async () => ({ action: 'continue' }) }]\n"

/** A plugin that carries every kind of part, all of them right. */
export function goodPlugin(set: FixtureSet, name = 'good'): string {
	return set.plugin(name, {
		'plugin.json': manifest({
			instructions: 'Explain the evidence first.',
			tools: ['tools/index.js'],
			hooks: ['hooks/index.js'],
			skills: ['skills/reconcile'],
			mcpServers: [{ name: 'ledger-db', command: 'node', args: ['server.js'] }],
			commands: ['commands'],
			agents: ['agents'],
			platforms: ['linux', 'darwin', 'win32'],
			engines: { namzu: '>=1.0.0' },
		}),
		'tools/index.js': TOOLS_JS,
		'hooks/index.js': HOOKS_JS,
		'skills/reconcile/SKILL.md': SKILL_OK,
		'server.js': '// a server\n',
		'commands/audit.md': COMMAND_OK,
		'agents/reviewer.md': AGENT_OK,
	})
}

export interface FixtureCase {
	readonly name: string
	readonly files: (set: FixtureSet) => Record<string, FixtureFile>
	/** Codes the report must carry as errors (and no other errors). */
	readonly errors: readonly string[]
	/** Codes the report must carry as warnings (a superset check). */
	readonly warnings: readonly string[]
}

const big = (head: string, bytes: number): string => `${head}${'x'.repeat(bytes)}\n`
const FIVE_MIB = 5 * 1024 * 1024

/** Each mistake in turn, on an otherwise good plugin where one is needed. */
export const FIXTURE_CASES: readonly FixtureCase[] = [
	{
		name: 'only-a-skill',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md': SKILL_OK,
		}),
		errors: [],
		warnings: [],
	},
	{
		name: 'manifest-not-json',
		files: () => ({ 'plugin.json': '{\n  "name": "x",\n  oops\n}' }),
		errors: ['manifest-json'],
		warnings: [],
	},
	{
		name: 'manifest-bad-name',
		files: () => ({ 'plugin.json': manifest({ skills: [] }, 'Ledger_Team') }),
		errors: ['manifest-schema'],
		warnings: [],
	},
	{
		name: 'manifest-missing-fields',
		files: () => ({ 'plugin.json': '{"name":"ledger"}' }),
		errors: ['manifest-schema', 'manifest-schema'],
		warnings: [],
	},
	{
		name: 'manifest-missing',
		files: () => ({ 'README.md': 'no manifest\n' }),
		errors: ['manifest-missing'],
		warnings: [],
	},
	{
		name: 'manifest-unknown-key',
		files: () => ({ 'plugin.json': manifest({ instructions: 'x', skils: ['a'] }) }),
		errors: [],
		warnings: ['manifest-unknown-key'],
	},
	{
		name: 'manifest-empty',
		files: () => ({ 'plugin.json': manifest() }),
		errors: [],
		warnings: ['manifest-empty'],
	},
	{
		name: 'manifest-version',
		files: () => ({ 'plugin.json': manifest({ instructions: 'x', version: 'one' }) }),
		errors: [],
		warnings: ['manifest-version-format'],
	},
	{
		name: 'manifest-connectors',
		files: () => ({ 'plugin.json': manifest({ instructions: 'x', connectors: ['crm'] }) }),
		errors: ['manifest-incompatible'],
		warnings: [],
	},
	{
		name: 'engines-too-new',
		files: () => ({
			'plugin.json': manifest({ instructions: 'x', engines: { namzu: '>=9999.0.0' } }),
		}),
		errors: ['manifest-incompatible'],
		warnings: [],
	},
	{
		name: 'engines-unreadable',
		files: () => ({ 'plugin.json': manifest({ instructions: 'x', engines: { namzu: 'newish' } }) }),
		errors: ['manifest-incompatible'],
		warnings: [],
	},
	{
		name: 'platform-other',
		files: () => ({ 'plugin.json': manifest({ instructions: 'x', platforms: ['plan9'] }) }),
		errors: ['manifest-incompatible'],
		warnings: [],
	},
	{
		name: 'manifest-huge',
		files: () => ({
			'plugin.json':
				big(`${manifest({ instructions: 'x' }).slice(0, -1)},"pad":"`, FIVE_MIB) + '"}',
		}),
		errors: ['manifest-too-large'],
		warnings: [],
	},
	{
		name: 'manifest-binary',
		files: () => ({ 'plugin.json': Buffer.from([0x7b, 0, 0, 0x7d]) }),
		errors: ['manifest-binary'],
		warnings: [],
	},
	{
		name: 'manifest-link',
		files: (set) => ({ 'plugin.json': { link: join(set.outsideDir, 'secret.md') } }),
		errors: ['manifest-not-regular'],
		warnings: [],
	},
	{
		name: 'engines-too-new-and-a-bad-skill',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'], engines: { namzu: '>=9999.0.0' } }),
			'skills/reconcile/SKILL.md': 'just text\n',
		}),
		errors: ['manifest-incompatible', 'skill-invalid'],
		warnings: [],
	},
	{
		name: 'skill-name-mismatch',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md': SKILL_OK.replace('name: reconcile', 'name: other'),
		}),
		errors: ['skill-invalid'],
		warnings: [],
	},
	{
		name: 'skill-no-description',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md': '---\nname: reconcile\n---\nbody\n',
		}),
		errors: ['skill-invalid'],
		warnings: [],
	},
	{
		name: 'skill-description-too-long',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md': `---\nname: reconcile\ndescription: ${'d'.repeat(1100)}\n---\nbody\n`,
		}),
		errors: ['skill-invalid'],
		warnings: [],
	},
	{
		name: 'skill-bad-invocation',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md': SKILL_OK.replace(
				'---\nCompare',
				'invocation: sometimes\n---\nCompare',
			),
		}),
		errors: ['skill-invalid'],
		warnings: [],
	},
	{
		name: 'skill-no-frontmatter',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md': 'just text\n',
		}),
		errors: ['skill-invalid'],
		warnings: [],
	},
	{
		name: 'skill-no-file',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/notes.txt': 'x',
		}),
		errors: ['path-missing'],
		warnings: [],
	},
	{
		name: 'skill-folder-missing',
		files: () => ({ 'plugin.json': manifest({ skills: ['skills/ghost'] }) }),
		errors: ['path-missing'],
		warnings: [],
	},
	{
		name: 'skill-path-dotdot',
		files: () => ({ 'plugin.json': manifest({ skills: ['../elsewhere'] }) }),
		errors: ['path-outside'],
		warnings: [],
	},
	{
		name: 'skill-folder-link-out',
		files: (set) => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile': { link: set.outsideDir },
		}),
		errors: ['path-outside'],
		warnings: [],
	},
	{
		name: 'skill-file-link-out',
		files: (set) => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md': { link: set.outsideSkill },
		}),
		errors: [],
		warnings: ['path-outside'],
	},
	{
		name: 'skill-unknown-key',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md': SKILL_OK.replace(
				'---\nCompare',
				'allowed_tools: Read\n---\nCompare',
			),
		}),
		errors: [],
		warnings: ['skill-unknown-key'],
	},
	{
		name: 'skill-long-description',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md': `---\nname: reconcile\ndescription: ${'d'.repeat(900)}\n---\nbody\n`,
		}),
		errors: [],
		warnings: ['skill-description-large'],
	},
	{
		name: 'skill-empty-body',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md': '---\nname: reconcile\ndescription: d\n---\n',
		}),
		errors: [],
		warnings: ['skill-body-empty'],
	},
	{
		name: 'skill-huge-but-valid',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md': big(SKILL_OK, FIVE_MIB),
		}),
		errors: [],
		warnings: ['file-too-large'],
	},
	{
		name: 'skill-binary',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md': Buffer.from([0x2d, 0x2d, 0x2d, 0, 1, 2]),
		}),
		errors: ['file-binary'],
		warnings: [],
	},
	{
		name: 'skill-listed-twice',
		files: () => ({
			'plugin.json': manifest({ skills: ['skills/reconcile', 'skills/reconcile'] }),
			'skills/reconcile/SKILL.md': SKILL_OK,
		}),
		errors: ['skill-duplicate'],
		warnings: [],
	},
	{
		name: 'tool-missing',
		files: () => ({ 'plugin.json': manifest({ tools: ['tools/none.js'] }) }),
		errors: ['path-missing'],
		warnings: [],
	},
	{
		name: 'tool-dotdot',
		files: () => ({ 'plugin.json': manifest({ tools: ['../tools.js'] }) }),
		errors: ['path-outside'],
		warnings: [],
	},
	{
		name: 'tool-link-out',
		files: (set) => ({
			'plugin.json': manifest({ tools: ['tools/index.js'] }),
			'tools/index.js': { link: set.outsideFile },
		}),
		errors: ['path-outside'],
		warnings: [],
	},
	{
		name: 'tool-is-folder',
		files: () => ({ 'plugin.json': manifest({ tools: ['tools'] }), 'tools/index.js': TOOLS_JS }),
		errors: ['path-not-file'],
		warnings: [],
	},
	{
		name: 'tool-ts',
		files: () => ({
			'plugin.json': manifest({ tools: ['tools/index.ts'] }),
			'tools/index.ts': TOOLS_JS,
		}),
		errors: [],
		warnings: ['module-extension'],
	},
	{
		name: 'tool-no-export',
		files: () => ({
			'plugin.json': manifest({ tools: ['tools/index.js'] }),
			'tools/index.js': 'export const other = 1\n',
		}),
		errors: [],
		warnings: ['module-export'],
	},
	{
		name: 'tool-binary',
		files: () => ({
			'plugin.json': manifest({ tools: ['tools/index.js'] }),
			'tools/index.js': Buffer.from([0x65, 0, 0x74]),
		}),
		errors: ['file-binary'],
		warnings: [],
	},
	{
		name: 'tool-huge',
		files: () => ({
			'plugin.json': manifest({ tools: ['tools/index.js'] }),
			'tools/index.js': big('export const tools = []\n//', FIVE_MIB),
		}),
		errors: [],
		warnings: ['file-too-large'],
	},
	{
		name: 'tool-listed-twice',
		files: () => ({
			'plugin.json': manifest({ tools: ['tools/index.js', 'tools/index.js'] }),
			'tools/index.js': TOOLS_JS,
		}),
		errors: [],
		warnings: ['part-duplicate'],
	},
	{
		name: 'hook-unknown-event',
		files: () => ({
			'plugin.json': manifest({ hooks: ['hooks/index.js'] }),
			'hooks/index.js':
				"export const hooks = [{ event: 'tool_finished', handler: async () => ({ action: 'continue' }) }]\n",
		}),
		errors: [],
		warnings: ['hook-event-unknown'],
	},
	{
		name: 'hook-renamed-event',
		files: () => ({
			'plugin.json': manifest({ hooks: ['hooks/index.js'] }),
			'hooks/index.js':
				"export const hooks = [{ event: 'run_end', handler: async () => ({ action: 'continue' }) }]\n",
		}),
		errors: [],
		warnings: ['hook-event-unknown'],
	},
	{
		name: 'mcp-url-field',
		files: () => ({
			'plugin.json': manifest({
				mcpServers: [{ name: 'db', command: 'node', url: 'https://example.test' }],
			}),
		}),
		errors: ['manifest-schema'],
		warnings: [],
	},
	{
		name: 'mcp-bad-timeout',
		files: () => ({
			'plugin.json': manifest({
				mcpServers: [{ name: 'db', command: 'node', connectTimeoutMs: -5 }],
			}),
		}),
		errors: ['manifest-schema'],
		warnings: [],
	},
	{
		name: 'mcp-command-outside',
		files: () => ({
			'plugin.json': manifest({
				mcpServers: [{ name: 'db', command: '/opt/elsewhere/server', args: ['../up.js'] }],
			}),
		}),
		errors: [],
		warnings: ['mcp-command-outside', 'mcp-arg-outside'],
	},
	{
		name: 'mcp-twice',
		files: () => ({
			'plugin.json': manifest({
				mcpServers: [
					{ name: 'db', command: 'node' },
					{ name: 'db', command: 'node' },
				],
			}),
		}),
		errors: [],
		warnings: ['mcp-duplicate-server'],
	},
	{
		name: 'commands-missing',
		files: () => ({ 'plugin.json': manifest({ commands: ['commands'] }) }),
		errors: ['path-missing'],
		warnings: [],
	},
	{
		name: 'commands-dotdot',
		files: () => ({ 'plugin.json': manifest({ commands: ['../commands'] }) }),
		errors: ['manifest-schema'],
		warnings: [],
	},
	{
		name: 'commands-link-out',
		files: (set) => ({
			'plugin.json': manifest({ commands: ['commands'] }),
			commands: { link: set.outsideDir },
		}),
		errors: ['path-outside'],
		warnings: [],
	},
	{
		name: 'command-unclosed',
		files: () => ({
			'plugin.json': manifest({ commands: ['commands'] }),
			'commands/audit.md': '---\ndescription: x\nno end\n',
		}),
		errors: ['command-invalid'],
		warnings: [],
	},
	{
		name: 'command-unknown-key',
		files: () => ({
			'plugin.json': manifest({ commands: ['commands'] }),
			'commands/audit.md': '---\ndescription: x\nallowed-tools: Read\n---\nDo it.\n',
		}),
		errors: [],
		warnings: ['command-unknown-key'],
	},
	{
		name: 'command-empty',
		files: () => ({
			'plugin.json': manifest({ commands: ['commands'] }),
			'commands/audit.md': '---\ndescription: x\n---\n',
		}),
		errors: [],
		warnings: ['command-empty'],
	},
	{
		name: 'command-link-file',
		files: (set) => ({
			'plugin.json': manifest({ commands: ['commands'] }),
			'commands/audit.md': { link: set.outsideFile },
			'commands/ok.md': COMMAND_OK,
		}),
		errors: [],
		warnings: ['file-ignored'],
	},
	{
		name: 'commands-two-dirs-same-name',
		files: () => ({
			'plugin.json': manifest({ commands: ['a', 'b'] }),
			'a/audit.md': COMMAND_OK,
			'b/audit.md': COMMAND_OK,
		}),
		errors: [],
		warnings: ['command-duplicate'],
	},
	{
		name: 'command-huge',
		files: () => ({
			'plugin.json': manifest({ commands: ['commands'] }),
			'commands/audit.md': big('', FIVE_MIB),
		}),
		errors: [],
		warnings: ['file-too-large'],
	},
	{
		name: 'agent-no-name',
		files: () => ({
			'plugin.json': manifest({ agents: ['agents'] }),
			'agents/reviewer.md': '---\ndescription: d\n---\nbody\n',
		}),
		errors: ['agent-invalid'],
		warnings: [],
	},
	{
		name: 'agent-reserved-name',
		files: () => ({
			'plugin.json': manifest({ agents: ['agents'] }),
			'agents/x.md': '---\nname: explore\ndescription: d\n---\nbody\n',
		}),
		errors: ['agent-invalid'],
		warnings: [],
	},
	{
		name: 'agent-bad-mode',
		files: () => ({
			'plugin.json': manifest({ agents: ['agents'] }),
			'agents/x.md': AGENT_OK.replace('---\nYou', 'permissionMode: sideways\n---\nYou'),
		}),
		errors: ['agent-invalid'],
		warnings: [],
	},
	{
		name: 'agent-misspelt-tools',
		files: () => ({
			'plugin.json': manifest({ agents: ['agents'] }),
			'agents/x.md': AGENT_OK.replace('tools:', 'tool:'),
		}),
		errors: [],
		warnings: ['agent-unknown-key'],
	},
	{
		name: 'agent-empty-body',
		files: () => ({
			'plugin.json': manifest({ agents: ['agents'] }),
			'agents/x.md': '---\nname: x\ndescription: d\n---\n',
		}),
		errors: ['agent-invalid'],
		warnings: [],
	},
	{
		name: 'agent-huge',
		files: () => ({
			'plugin.json': manifest({ agents: ['agents'] }),
			'agents/x.md': big(AGENT_OK, FIVE_MIB),
		}),
		errors: ['file-too-large'],
		warnings: [],
	},
	{
		name: 'agents-missing',
		files: () => ({ 'plugin.json': manifest({ agents: ['agents'] }) }),
		errors: ['path-missing'],
		warnings: [],
	},
]
