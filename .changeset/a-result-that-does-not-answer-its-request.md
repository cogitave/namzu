---
"@namzu/sdk": minor
---

A tool result can be judged against the request that produced it

`ToolResultGuardrailContext` has carried the validated `input` alongside the `output` since the tool-result boundary was added, and nothing read the two together. `toolResultCorrespondenceGuardrail()` reads them: a result handed back the request instead of an answer to it is refused, which needs no pattern list to look wrong and shares no blind spot with the one that has.

All four questions the issue that asked for this settled:

- **What "corresponds" means, for arbitrary tools.** One thing, and it is the failure that needs no domain knowledge: the result restates the request. A tool handed a question and returning that question answered nothing, whatever it is a tool for. The comparison is exact equality after whitespace normalisation against each string the call carried, so a result that says anything extra passes — quoting the request inside a larger answer is an answer. A connector's result reaches a screen already wrapped by `wrapUntrusted`, so the body inside that frame is compared too; comparing only the raw output would never match the case the screen is most worth having.
- **A weather lookup for one city answering about another.** Not decidable, and this does not guess at it. It needs a declaration of which argument names the subject, and the framework cannot infer one: for a file read the answer is the file's contents, which do not name the path, so the natural rule — an answer mentions its subject — would refuse every ordinary read. A host that knows a tool's subject can write that screen in a few lines against the same context, which is what this boundary was built to allow.
- **Opt-in per tool, for the one case that needs it.** A tool whose answer legitimately IS the request — a validator, a normaliser, a dry run — is named in `ToolResultCorrespondenceOptions.passthroughTools`. Nothing on the context tells those from a tool that answered nothing, so the host that knows says so. Validator and formatter tools are the whole false-positive surface of the check, and this is the escape hatch rather than a tuning knob.
- **What it does on a partial match.** It passes. Only a whole output that equals a request string refuses, and request strings shorter than 16 characters are not compared at all: a one-word echo cannot be told from a one-word answer, and `ls` of a directory holding one entry called `src` returns exactly that.

**Nothing a default run does changes.** The screen ships as a preset, not as a default. `new ToolRegistry()` and `runAgent({ tools: new ToolRegistry() })` screen no results at all, exactly as before, and a test pins that a result is returned as the tool produced it when no `resultGuardrails` are configured. That is the same invariant the boundary shipped with, and the reason it holds is the one written down there: adding a control must not change an existing host's behaviour on upgrade. Take the version for the exported symbol.

**Turning it on.** `new ToolRegistry({ resultGuardrails: [toolResultCorrespondenceGuardrail()] })`. Like the injection screen, it is a registry-construction option rather than a run-config one — a host looking for it beside `inputGuardrails` will not find it, and the CLI builds its registry with no screens and has no flag for them.

New exports: `toolResultCorrespondenceGuardrail`, `ToolResultCorrespondenceOptions`. The screen is deliberately narrow and says so: an answer about the wrong subject, an answer that is plausible prose, and a restatement shorter than the floor all pass. Three things it does not touch, each for a reason rather than for lack of time: an empty result for a non-empty request (a search that matched nothing returns nothing), a shape contradicting `ToolDefinition.outputSchema` (documented as shown to the model, never validated), and a failed call (the text is a diagnostic, and a refusal replaces the output).
