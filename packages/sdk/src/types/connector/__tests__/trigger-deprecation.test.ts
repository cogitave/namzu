/**
 * Connector triggers were advertised as an SDK capability even though the
 * runtime has no subscriber, dispatcher or run-admission path for them. A
 * direct removal was tempting, but `ConnectorRegistry` is public and returns
 * definitions verbatim: a host may already use the field as its own metadata.
 *
 * This file pins both halves of the migration. The declarations carry formal
 * TypeScript deprecation tags, while the package-root types and registry
 * round-trip remain intact until the later major removal.
 */

import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ConnectorRegistry } from '../../../index.js'
import type {
	ConnectorDefinition,
	ConnectorEvent,
	ConnectorId,
	ConnectorTrigger,
} from '../../../index.js'

function source(relative: string): ts.SourceFile {
	const text = readFileSync(new URL(relative, import.meta.url), 'utf8')
	return ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function hasDeprecatedTag(node: ts.Node): boolean {
	return ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'deprecated')
}

function interfaceNamed(file: ts.SourceFile, name: string): ts.InterfaceDeclaration {
	const declaration = file.statements.find(
		(statement): statement is ts.InterfaceDeclaration =>
			ts.isInterfaceDeclaration(statement) && statement.name.text === name,
	)
	if (!declaration) throw new Error(`Missing interface ${name}`)
	return declaration
}

describe('the connector-trigger migration window', () => {
	it('marks every false SDK-dispatch promise as deprecated', () => {
		const core = source('../core.ts')
		const definition = interfaceNamed(source('../definition.ts'), 'ConnectorDefinition')
		const triggers = definition.members.find(
			(member): member is ts.PropertySignature =>
				ts.isPropertySignature(member) &&
				ts.isIdentifier(member.name) &&
				member.name.text === 'triggers',
		)

		expect(hasDeprecatedTag(interfaceNamed(core, 'ConnectorTrigger'))).toBe(true)
		expect(hasDeprecatedTag(interfaceNamed(core, 'ConnectorEvent'))).toBe(true)
		expect(
			triggers,
			'ConnectorDefinition.triggers disappeared before its migration release',
		).toBeDefined()
		expect(hasDeprecatedTag(triggers!)).toBe(true)
	})

	it('preserves a host-owned subscription built from package-root types', () => {
		const trigger: ConnectorTrigger = {
			name: 'issue-created',
			description: 'Host subscription metadata',
			event: 'issue.created',
		}
		const definition: ConnectorDefinition = {
			id: 'conn_host_subscription' as ConnectorId,
			name: 'Host subscription',
			description: 'The host, not the SDK, dispatches this event',
			connectionType: 'custom',
			configSchema: z.object({}),
			methods: [],
			triggers: [trigger],
		}
		const registry = new ConnectorRegistry()
		registry.register(definition)

		const subscriptions = registry.getOrThrow(definition.id).triggers ?? []
		const delivered: ConnectorEvent = {
			connectorId: definition.id,
			instanceId: 'cni_host_subscription' as ConnectorEvent['instanceId'],
			trigger: subscriptions[0]!.name,
			payload: { issue: 42 },
			timestamp: 1,
		}

		expect(subscriptions).toEqual([trigger])
		expect(delivered).toMatchObject({ trigger: 'issue-created', payload: { issue: 42 } })
	})
})
