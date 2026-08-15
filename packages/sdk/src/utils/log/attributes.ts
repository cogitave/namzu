// The allowlist for a hand-built attribute bag. `LogContext` on
// `../logger.ts` stays exactly what it is — `Record<string, unknown>` —
// because `Logger.child(context: LogContext)` is in INPUT position on the
// public surface (`logger?: Logger` on `RunConfig` and tool config:
// `types/run/config.ts:156`, `types/tool/index.ts:396`): narrowing it would
// break every host that already implemented `Logger` correctly, for a type
// change with no payoff to them. `LogAttributes` is instead a type a caller
// builds TOWARD — construct the variable half of a log call with this type
// and hand the result to `Logger.info`/`.child()` where `LogContext` is
// expected. That direction always compiles: every `LogAttributes` value is
// already a valid `LogContext` value, never the reverse.
//
// Two things this closes as a compile error rather than leaving to review:
// a key outside the four prefixes the rest of the telemetry surface already
// uses (`serverId`, `label`, `apiKey` — anything un-namespaced), and a
// nested object value (the shape a splatted `AuthConfig`, `ResolvedConfig`
// or `process.env` would need, and the OTel `AnyValue` subset below has no
// room for one).
//
// What it does NOT close: `{ 'namzu.connector.auth': JSON.stringify(auth) }`
// is a namespaced key holding a string, and passes every rule in this file.
// A secret in string form is not a shape this type can see — closing THAT
// is the record-boundary redaction scan's job (`redact.ts`), which runs on
// every record regardless of what built its attributes. Say so wherever
// this type is documented; it narrows what a caller can express, it does
// not make leakage inexpressible.
type AttributeValue = string | number | boolean | readonly (string | number | boolean)[]

type AttributeKey =
	| `namzu.${string}`
	| `gen_ai.${string}`
	| `service.${string}`
	| `exception.${string}`

/**
 * A namespaced, shape-safe attribute bag. Deliberately NOT
 * `Partial<Record<...>>`: `Partial` would type every property as
 * `AttributeValue | undefined`, and this repo's tsconfig does not set
 * `exactOptionalPropertyTypes` — so a `Partial` version would let
 * `{ 'namzu.x.y': undefined }` compile, an attribute that is present and
 * holds nothing. Plain `Record` over a template-literal key domain does not
 * require every possible key to appear — there is no finite set of keys to
 * require — so dropping `Partial` costs a caller nothing: it still supplies
 * only the keys it has, and gains that an explicit `undefined` is rejected
 * the same way `null` and a nested object already are.
 */
export type LogAttributes = Readonly<Record<AttributeKey, AttributeValue>>
