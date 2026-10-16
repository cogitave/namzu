---
type: Guide
title: Decision models
description: Provider-agnostic System-1 decision models (yes/no, choice, score) and the Azure AI Foundry Microsoft-Decision-1 driver.
resource: packages/decision
tags: [sdk, decision]
---

# Decision models

`@namzu/decision` wraps System-1 decision models: fast, non-generative models
that return a typed decision rather than text. Three shapes exist:

- **yes/no**: the probability that the answer is true (`{ p }`, 0 to 1).
- **choice**: one of several options plus a probability per option.
- **score**: a level (an index into a list of level names) plus a probability per level.

The package is a leaf: no runtime dependencies and no workspace imports.

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
