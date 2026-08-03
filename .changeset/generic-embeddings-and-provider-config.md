---
'@namzu/sdk': major
'@namzu/cli': patch
'@namzu/files': minor
---

Three public identifiers named a vendor where the code was generic. Renamed,
and in two cases the naming was hiding a design problem worth fixing.

**`OpenRouterEmbeddingProvider` → `HttpEmbeddingProvider`** (config type
likewise). Nothing about the class was vendor-specific: it POSTs to
`{baseUrl}/embeddings` with a bearer key and reads back
`{ data: [{ index, embedding }] }` — the shape every hosted embeddings
service speaks. Only the name and a default host said otherwise.

`baseUrl` is now **required**. It defaulted to one vendor's host, which
meant a caller who never named an endpoint still shipped its text to one. A
default network destination is a decision the caller has to make out loud.
A trailing slash is now tolerated rather than producing a doubled path.

**`AgentFactoryOptions.provider`** was `'openrouter' | 'bedrock'` — a closed
two-member union in a generic factory, naming two specific services that the
provider registry has never been limited to and that no caller could extend.
It is now `string`: any registered provider type.

**`AgentFactoryOptions.bedrockConfig`** is replaced by
`providerConfig?: Record<string, unknown>`, passed through untouched. The
old field existed for exactly one service and had no construction site
anywhere in the workspace.

**`StorageProviderId`**: the `'anthropic-files'` member is now
`'provider-files'`.
