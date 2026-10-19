/**
 * The admission fence as the cluster would store it: parsed from the SHIPPED
 * manifests, so a test of the fence check runs against the objects an operator
 * applies and a drifted manifest fails here instead of being masked by a
 * hand-written copy.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseAllDocuments } from 'yaml'

const MANIFESTS = join(dirname(fileURLToPath(import.meta.url)), '../../../../../k8s/manifests')

type Doc = Record<string, unknown>

function load(file: string): Doc[] {
	return parseAllDocuments(readFileSync(join(MANIFESTS, file), 'utf8')).map((d) => d.toJS() as Doc)
}

function pick(docs: readonly Doc[], kind: string): Doc {
	const found = docs.find((d) => d.kind === kind)
	if (found === undefined) throw new Error(`no ${kind} in the shipped manifest`)
	return found
}

/** A deep copy a test may mutate without touching the next test's. */
function clone<T>(value: T): T {
	return structuredClone(value)
}

export interface FenceObjects {
	policy: Doc
	binding: Doc
	companionPolicy: Doc
	companionBinding: Doc
	configMap: Doc
}

/** Fresh copies of every shipped admission object and the example parameter. */
export function shippedFence(): FenceObjects {
	const main = load('validatingadmissionpolicy-cilium.yaml')
	const companion = load('validatingadmissionpolicy-cilium-permitted-hosts.yaml')
	return {
		policy: clone(pick(main, 'ValidatingAdmissionPolicy')),
		binding: clone(pick(main, 'ValidatingAdmissionPolicyBinding')),
		companionPolicy: clone(pick(companion, 'ValidatingAdmissionPolicy')),
		companionBinding: clone(pick(companion, 'ValidatingAdmissionPolicyBinding')),
		configMap: clone(pick(companion, 'ConfigMap')),
	}
}

/** `spec` of one of the objects, typed loosely for a test that edits it. */
export function specOf(object: Doc): Record<string, unknown> {
	return object.spec as Record<string, unknown>
}
