---
type: Guide
title: Decision models
description: Provider-agnostic System-1 decision models (yes/no, choice, score), the Azure and HTTP drivers, the fail-open decide tool and the CLI decision config block.
resource: packages/decision
tags: [sdk, decision]
---

# Decision models

`@namzu/decision` wraps System-1 decision models: fast, non-generative models
that return a typed decision rather than text. Three shapes exist:

- **yes/no**: the probability that the answer is true (`{ p }`, 0 to 1).
- **choice**: one of several options plus a probability per option.
- **score**: a level (an index into a list of level names) plus a probability per level.

The package is private and bundled into the CLI, never published to npm. The
drivers have no runtime dependencies; the agent-facing `decide` tool pulls in
`zod` and peer-depends on `@namzu/sdk` (for `defineTool`), the only workspace
import.

## The interface

```ts sketch
interface DecisionModel {
  yesno(state: string, instructions: string, opts?: DecisionRequestOptions): Promise<YesNoDecision>
  choice<const T extends string>(state: string, instructions: string, options: readonly T[], opts?: DecisionRequestOptions): Promise<ChoiceDecision<T>>
  score(state: string, instructions: string, levels: readonly string[], opts?: DecisionRequestOptions): Promise<ScoreDecision>
}
```

Failures throw `DecisionError`, which carries the HTTP `status` and the
service's error `code` when there is one. `opts.signal` aborts the request.

## Azure AI Foundry driver

`AzureFoundryDecisionModel` talks to Microsoft-Decision-1 on Azure AI Foundry.
It takes the resource `endpoint`, the Foundry `deployment` name, and a
`getToken` function returning an Entra bearer token, so the package needs no
Azure SDK. A `fetch` can be injected for tests.

Each call is a `POST` to `<endpoint>/providers/microsoft/v1/systemone` with
`Authorization: Bearer <token>` and a body of
`{ model, state, questions: { q } }`.

Yes/no is verified live: the question is `{ type: 'noul', instructions }` and
the answer is `answers.q.noul`. The choice (`options`) and score (`levels`)
request shapes are provisional until confirmed against the Foundry schema; the
driver parses their answers defensively.

## HTTP driver

`HttpDecisionModel` talks to any service that implements the same request and
answer shapes over plain HTTP. It takes a `url`, an optional `model`, an
optional `apiKey` (sent as a bearer token; keyless when absent) and optional
extra `headers`. A `fetch` can be injected for tests.

## Choosing a driver

`createDecisionModel(config)` returns a `DecisionModel` for a config whose
`provider` is `'azure'` (`endpoint`, `deployment`, `getToken`) or `'http'`
(`url`, `model?`, `apiKey?`, `headers?`).

## The `decide` tool

`createDecisionTool(model)` builds the agent-facing `decide` tool. Its input is
`{ kind: 'yesno' | 'choice' | 'score', context, question, options?, levels? }`
and its result is the typed decision. The tool is optional and advisory: the
agent chooses whether to call it and may ignore the answer.

It is fail-open. When the model errors, times out or is unreachable, the tool
still returns a successful result saying the decision model is unavailable and
the agent should proceed on its own judgement. A turn never fails because of it.

## Configuring it in the CLI

The CLI mounts `decide` on the host agent and on Pal agents when the config
file has a `decision` block. Without the block the tool is not mounted.

```yaml
# Azure AI Foundry
decision:
  provider: azure
  endpoint: https://my-resource.services.ai.azure.com
  deployment: my-decision-deployment
  tokenEnv: AZURE_FOUNDRY_TOKEN   # optional; this is the default
```

```yaml
# Any HTTP decision service
decision:
  provider: http
  url: https://decisions.example.com/v1/decide
  model: my-model          # optional
  apiKeyEnv: DECISION_KEY  # optional; keyless when unset
```

Auth is declarative: the config names the environment variable that holds the
credential (`tokenEnv`, `apiKeyEnv`) and never carries the value. The variable
is read each time a decision is requested. Resolving a token through `az` or a
managed identity is a deliberate future seam. A block with an unknown
`provider`, a missing required key or a key from the other provider is refused
at load, like any other malformed setting. The block is file-only, never set
from the environment, because it names an endpoint that conversation context is
sent to.
