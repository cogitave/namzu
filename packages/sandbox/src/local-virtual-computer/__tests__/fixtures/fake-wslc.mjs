#!/usr/bin/env node
// A stand-in for wslc.exe, pinned to what the spike recorded from wslc 3.0.1.0:
// UTF-8 output with CRLF line ends, `Error code: WSLC_E_*` on stderr with exit
// 1, single-line `inspect -f json` arrays, no Go templates, `ps -q` ids cut to
// 12 characters unless --no-trunc, and the unsupported flags rejected exactly
// as the real CLI rejects them. State lives in $FAKE_WSLC_STATE/state.json.
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const stateFile = join(process.env.FAKE_WSLC_STATE ?? '.', 'state.json')
const load = () => {
	try {
		return JSON.parse(readFileSync(stateFile, 'utf8'))
	} catch {
		return { containers: {}, volumes: {}, calls: [] }
	}
}
const state = load()
const save = () => writeFileSync(stateFile, JSON.stringify(state))
const out = (text) => process.stdout.write(`${text.split('\n').join('\r\n')}\r\n`)
const fail = (text, code) => {
	process.stderr.write(
		`${text}\r\n${code ? `Error code: ${code}\r\nIf this error was unexpected, please consider searching for existing issues or filing a new issue at https://github.com/microsoft/WSL/issues.\r\n` : ''}`,
	)
	process.exit(1)
}

const argv = process.argv.slice(2)
state.calls.push({ argv, hasToken: Boolean(process.env.NAMZU_SANDBOX_TOKEN) })
save()

const image = process.env.FAKE_WSLC_IMAGE ?? 'namzu-local-computer:1'
const ports = (process.env.FAKE_WSLC_PORTS ?? '41124,41125').split(',')
const flag = (name) => {
	const index = argv.indexOf(name)
	return index >= 0 ? argv[index + 1] : undefined
}
const trailing = () => argv[argv.length - 1]

function matches(container, filter) {
	if (filter.startsWith('name=')) {
		const pattern = new RegExp(filter.slice(5).replace('^/', '^').replace(/\$$/, '$'))
		return pattern.test(container.name)
	}
	if (filter.startsWith('label=')) {
		const [key, ...rest] = filter.slice(6).split('=')
		return container.labels[key] === rest.join('=')
	}
	return true
}

const [command, sub] = argv
if (command === 'version') {
	out(process.env.FAKE_WSLC_VERSION ?? 'wslc 3.0.1.0')
} else if (command === 'ps') {
	if (process.env.FAKE_WSLC_SESSION_ERROR) fail('The session could not start.', process.env.FAKE_WSLC_SESSION_ERROR)
	if (argv.includes('--format') && flag('--format') !== 'json')
		fail(`Invalid format value: ${flag('--format')} is not a recognised format type. Supported format types are: json.`)
	const filter = flag('--filter')
	const ids = Object.entries(state.containers)
		.filter(([, container]) => !filter || matches(container, filter))
		.map(([id]) => (argv.includes('--no-trunc') ? id : id.slice(0, 12)))
	if (ids.length) out(ids.join('\n'))
} else if (command === 'image' && sub === 'inspect') {
	if (trailing() !== image) fail(`Image '${trailing()}' not found.`, 'WSLC_E_IMAGE_NOT_FOUND')
	out(
		JSON.stringify(
			[{ Os: 'linux', Config: { User: '1001:1001', Labels: { 'org.namzu.local-computer.protocol': '1' } } }],
			null,
			2,
		),
	)
} else if (command === 'volume' && sub === 'inspect') {
	const volume = state.volumes[trailing()]
	if (!volume) fail(`Object not found: ${trailing()}`, 'WSLC_E_VOLUME_NOT_FOUND')
	out(JSON.stringify([{ Name: trailing(), Labels: volume.labels }], null, 2))
} else if (command === 'volume' && sub === 'create') {
	if (argv.includes('--ignore')) fail("Option name was not recognised for the current command: '--ignore'")
	if (state.volumes[trailing()]) fail(`Volume '${trailing()}' already exists.`, 'WSLC_E_VOLUME_ALREADY_EXISTS')
	const [key, ...rest] = (flag('--label') ?? '').split('=')
	state.volumes[trailing()] = { labels: { [key]: rest.join('=') } }
	save()
	out(trailing())
} else if (command === 'run') {
	for (const unsupported of ['--cap-drop', '--security-opt', '--read-only', '--ipc', '--cgroups'])
		if (argv.some((arg) => arg === unsupported || arg.startsWith(`${unsupported}=`)))
			fail(`Option name was not recognised for the current command: '${unsupported}'`)
	if (!argv.includes('--detach') || !argv.includes('--pull=never')) fail('Unexpected run arguments.')
	if (!argv.includes(image)) fail(`No such image: ${trailing()}`, 'WSLC_E_IMAGE_NOT_FOUND')
	if (!process.env.NAMZU_SANDBOX_TOKEN) fail('The worker token was not inherited.')
	const labels = {}
	argv.forEach((arg, index) => {
		if (arg === '--label') {
			const [key, ...rest] = (argv[index + 1] ?? '').split('=')
			labels[key] = rest.join('=')
		}
	})
	const id = randomBytes(32).toString('hex')
	state.containers[id] = { name: flag('--name'), labels, running: true, token: process.env.NAMZU_SANDBOX_TOKEN }
	save()
	out(id)
} else if (command === 'inspect') {
	if (flag('-f') !== 'json') fail(`Invalid format value: ${flag('-f')} is not a recognised format type. Supported format types are: json.`)
	const target = trailing()
	const entry = Object.entries(state.containers).find(([id, c]) => id === target || c.name === target)
	if (!entry) fail(`Object not found: ${target}`, 'WSLC_E_CONTAINER_NOT_FOUND')
	const [id, container] = entry
	const host = (port) => [{ HostIp: '127.0.0.1', HostPort: port }]
	process.stdout.write(
		`${JSON.stringify([
			{
				Id: id,
				Name: `/${container.name}`,
				Labels: container.labels,
				NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.2' } } },
				Ports: { '2024/tcp': host(ports[0]), '2025/tcp': host(ports[1]) },
				State: { Running: container.running, Status: container.running ? 'running' : 'exited' },
			},
		])}\r\n`,
	)
} else if (command === 'stop' || command === 'rm') {
	const target = trailing()
	const known = state.containers[target]
	if (!known) fail(`Container '${target}' not found.`, 'WSLC_E_CONTAINER_NOT_FOUND')
	if (command === 'stop') known.running = false
	else delete state.containers[target]
	save()
	out(target)
} else {
	fail(`Unknown command: ${argv.join(' ')}`)
}
