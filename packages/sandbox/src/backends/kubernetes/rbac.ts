/**
 * The verbs a CLAIM-ONLY host issues — the pool-only path, written down once
 * so `k8s/manifests/rbac-claimant.yaml`, and the test that compares it to both
 * this list and the call sites behind it, cannot drift from the code they
 * describe.
 *
 * A host that sets `warmPoolName` and never creates a `Sandbox` itself needs
 * a strictly smaller grant than `k8s/manifests/rbac.yaml`'s, and the smaller
 * it is the more it matters that it is EXACT. Two failure directions, and
 * this constant is the one place both are decided:
 *
 *  - **Too few verbs** is a `403` on a flow nobody ran in review. The four
 *    `list` verbs are the load-bearing ones, and the two a host can go a long
 *    time without noticing are the sharp ones: `sandboxclaims: list` is the
 *    crash-recovery read (`releaseKubernetesTaskSandboxes`) and the
 *    pool-membership read (`readKubernetesTaskCapacity`), and `pods: list` is
 *    `readBoundPod`'s fallback read by the bound Sandbox's own selector and
 *    `readKubernetesTaskCapacity`'s count of Pending pods. The ACQUIRE path
 *    never notices either is missing — `create()` never lists either
 *    collection, so a claim is still created, bound, renewed and released
 *    exactly as before — which makes the failure DEFERRED rather than quiet:
 *    the `await client.request` inside each of those two functions rejects
 *    with a `KubernetesCredentialError` (`403`), and neither call catches one,
 *    so the first release or capacity read a host makes fails loudly, with the
 *    refused verb and the collection's path in the error. The other two are
 *    load-bearing SOONER: `list` is what both policy checks need, and the
 *    ingress one runs by default before every create.
 *  - **One verb too many** is the vulnerability class issue #500 is about: a
 *    `sandboxes: create` grant against a namespace running a privileged
 *    workspace template is an arbitrary privileged pod for anyone holding
 *    it. Every verb below has a call site named against it in the list.
 *
 * The path this describes is the CLAIM path, not the task tier as a whole:
 * with `warmPoolName` unset the same backend POSTs a `Sandbox` instead of a
 * claim, reads its `SandboxTemplate` first, and patches and deletes that
 * object — none of which is granted here, deliberately. See the manifest's
 * own header for what it declines to grant and why.
 *
 * Kept honest by a test rather than by review, and the test reaches the CODE
 * rather than only this list: `k8s/__tests__/manifests.test.ts` reads the
 * pool-only path's own files — `index.ts`, `objects.ts`, `ingress-policy.ts`,
 * `egress-policy.ts` — as text, resolves every literal `client.request(
 * '<METHOD>', <path>, …)` in them to the `(apiGroup, resource, verb)` triple
 * the builder that path goes through addresses, and FAILS on anything it
 * cannot resolve — an unknown builder, a path it cannot follow, a builder
 * call with anything appended to it (`podPath(ns, name) + '/log'` is the
 * `pods/log` subresource, which RBAC authorizes separately), a name the source
 * writes a second path to — the guard reads four spellings, wherever each is
 * written rather than only where it opens a statement: a plain assignment
 * (`path = …`, the one-line branch included), a compound one (`path += …`), a
 * `for (path of …)` binding, and a destructuring target (`({ path } = …)`) — as
 * a `const`/`let`/`var`-declared name, whose initializer is then not what a
 * request through it sends, or as a wrapper's own path parameter, whose call
 * sites then do not say what it sends — a path
 * that is a parameter of a body whose call sites the scan has not been told
 * about, a wrapper declared as such in a file the scan does not read — so a new
 * request has to declare itself instead of escaping. WHICH files those are
 * is not a list that can quietly stop covering the path: every `.ts` under
 * `src/backends/kubernetes/` that reaches the client — calling
 * `client.request(…)` itself in either spelling the scan reads, the literal
 * one or a computed `client['request']`, or naming `listPolicies`, the one
 * wrapper the scan knows, which takes its path as an argument; every half read
 * on text with its comments blanked — is either scanned or declared off the
 * path with its reason, so a file that reaches the client fails that test
 * until someone decides which of the two it is. The triples it
 * observes must be exactly this list, plus the four the pool-LESS branch
 * issues and this grant declines by design. A request added to the pool-only
 * path therefore fails that test naming the resource, the file and the line,
 * instead of surfacing as a `403` in a host's log — and so does a rule here
 * with no call site, which is a grant wider than the code needs.
 *
 * What that test still cannot see, so none of the above reads stronger than
 * it is: the files it declares off the path — `workspace.ts`, `k8s-client.ts`,
 * `transport.ts` — are never resolved to triples, a wrapper call site in one
 * of them included, since call sites are read from the scanned files only; and
 * that a claimant host never reaches `workspace.ts` is a claim about the
 * DEPLOYMENT (`warmPoolName` set, no `Sandbox` created by that host), which
 * nothing in this repository measures. A wrapper reached by ANOTHER name is outside that file predicate,
 * which matches the wrapper's name and not its identity: a file importing a
 * re-export of it, or calling a helper one level further out that calls it, is
 * neither scanned nor required to be declared. A request whose path is a
 * parameter of an expression-bodied arrow is likewise outside what the scan
 * matches, and a body the scan could not register — a class method, or an
 * object literal's shorthand method, declared INSIDE one of the bodies it
 * reads — is attributed to the body that encloses it, so its own parameters
 * are invisible. The assignment guard is by name in the file it resolves in,
 * not by scope, so a BINDING it registers nowhere shadows nothing there: a
 * destructuring parameter (`function f({ path })`) keeps its positional slot
 * without a name this scan can match, a `catch (path)` is not read at all, and
 * a write made to an exported binding from ANOTHER module is not in that file's
 * text — which is also to say that an assignment to a same-named local in an
 * unrelated function of the same file refuses the request too, a false refusal
 * rather than an escape. A parameter carrying a DEFAULT is written with an `=`
 * (`function f(path = …)`, `function f({ path } = {})`), so the guard reads it
 * and refuses the request rather than resolving it — a refusal, where the bare
 * pattern would have resolved or failed; and a destructuring pattern nested
 * inside another (`({ a: { path } } = …)`) is read by neither spelling, which
 * is measured green.
 *
 * **That list is the SHORT form, not the list.** It is carried in full in the
 * header of `k8s/__tests__/manifests.test.ts`, which also holds two bullets
 * this paragraph does not: `a path assembled by an operation the scan does not
 * model`, and `the cluster` (nothing there contacts an API server, so no live
 * `Role` is measured).
 *
 * Exported from the package root because the grant is a property of the
 * backend, not of a file this package does not publish: `k8s/` is outside
 * the `files` array, so a consumer cannot read the YAML out of `node_modules`
 * — it can, however, compare its own applied `Role` against this.
 */

/** An RBAC verb this backend issues. No wildcard, and none is ever added. */
export type KubernetesRbacVerb = 'create' | 'get' | 'list' | 'patch' | 'delete'

/**
 * One `rules[]` entry, in the shape RBAC itself uses — one resource per
 * entry, which is also how the shipped manifests are written, so a rule here
 * and a rule there compare field for field.
 */
export interface KubernetesRbacRule {
	/** The `apiGroups` entry, verbatim: `''` for the core group. */
	readonly apiGroup: string
	readonly resource: string
	readonly verbs: readonly KubernetesRbacVerb[]
}

/**
 * Every verb the pool-only path issues, each pinned to its call site in
 * `./index.ts` (and, for the policy checks, `./ingress-policy.ts` /
 * `./egress-policy.ts`):
 *
 *  - `sandboxclaims` — `create` is the acquire's POST (`createPath`), `get`
 *    the readiness poll that waits for the controller to bind one, `patch`
 *    the lease renewal that keeps a long run's claim alive, `delete` the
 *    release `destroy()` and a failed acquire's cleanup both send, and
 *    `list` the two host-invoked reads named above.
 *  - `sandboxes: get` — read for `status.selector` when the pod-by-name GET
 *    comes back gone, which on the claim path is the ONLY way to find the
 *    bound pod: a claim has no `podSelector` of its own to fall back on.
 *  - `sandboxwarmpools: get` — `readKubernetesTaskCapacity` reads the
 *    configured pool's own `status.readyReplicas`/`spec.replicas` before a
 *    host admits more work.
 *  - `pods` — `get` by name for the agent's bind token and, under
 *    `agentAddress: 'pod-ip'`, its address, plus the whole-namespace `list`
 *    that counts in-flight scale-up. The two policy checks use NO pod
 *    subresource; the agent's protocol is a socket the guest serves, not
 *    `pods/exec`.
 *  - `networkpolicies` / `ciliumnetworkpolicies` — `list` is the ingress
 *    coverage check (on by default before every create) and the egress UNION
 *    check (on by default whenever `config.egress` is set); `get` is the
 *    egress named-object check, also only under `config.egress`. Under
 *    `engine: 'core'` the Cilium rule simply never matches, and a cluster
 *    with no Cilium CRDs installed never has an object to match it.
 */
export const KUBERNETES_CLAIMANT_RBAC_RULES: readonly KubernetesRbacRule[] = Object.freeze([
	// Every RULE is frozen too, not just the array and the verb lists: a
	// frozen array still hands out mutable elements, so a plain-JS consumer
	// could rewrite `rule.resource` and compare its live `Role` against a
	// grant this module never declared. The test pins that (see
	// `k8s/__tests__/manifests.test.ts`), because a `readonly` modifier is
	// TypeScript's promise and not the runtime's.
	Object.freeze({
		apiGroup: 'extensions.agents.x-k8s.io',
		resource: 'sandboxclaims',
		verbs: Object.freeze(['create', 'get', 'list', 'patch', 'delete'] as const),
	}),
	Object.freeze({
		apiGroup: 'agents.x-k8s.io',
		resource: 'sandboxes',
		verbs: Object.freeze(['get'] as const),
	}),
	Object.freeze({
		apiGroup: 'extensions.agents.x-k8s.io',
		resource: 'sandboxwarmpools',
		verbs: Object.freeze(['get'] as const),
	}),
	Object.freeze({
		apiGroup: '',
		resource: 'pods',
		verbs: Object.freeze(['get', 'list'] as const),
	}),
	Object.freeze({
		apiGroup: 'networking.k8s.io',
		resource: 'networkpolicies',
		verbs: Object.freeze(['get', 'list'] as const),
	}),
	Object.freeze({
		apiGroup: 'cilium.io',
		resource: 'ciliumnetworkpolicies',
		verbs: Object.freeze(['get', 'list'] as const),
	}),
])
