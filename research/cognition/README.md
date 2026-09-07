# Cognitive control experiments

These are inspectable research mechanisms built alongside Namzu. The shipped CLI
does not load them. They use no paid provider or downloaded model. The complete
[design and scientific basis](../../docs/sdk/cognitive-architecture.md) separates
neuroscience evidence, software proposals and missing capabilities.
The [recorded validation](VALIDATION.md) distinguishes observed mechanism
behavior, local computation cost and the checks performed.

From the repository root, using the workspace's already installed dependencies:

```bash
pnpm -r build
node --test research/cognition/association.test.mjs research/cognition/executive.test.mjs
node research/cognition/sdk-probe.mjs /tmp/namzu-cognition-sdk-probe.json
node research/cognition/resource-probe.mjs
node research/cognition/storage-probe.mjs /tmp/namzu-cognition-storage.json
```

The SDK probe needs the built public SDK and its Zod dependency. Its provider is
scripted and network access is refused. Temporary runtime state is confined to
an owned directory and removed on exit; the optional report remains at the path
given on the command line.

The storage probe additionally requires Node 24 with built-in `node:sqlite` and
FTS5. This is a research-only runtime requirement, not a change to the SDK's
supported Node versions. It compares payload materialization in the current
disk store with a small experimental text index; it is not a production store
adapter or a semantic-search benchmark. See the proposed
[storage boundaries](../../docs/sdk/cognitive-storage.md).

## What is executable

`association.mjs` uses sparse restart diffusion over a host-provided candidate
graph. Nodes and edges are scoped; inactive-scope data is excluded before
normalization. It returns activation for retrieval ranking, not factual
confidence. Inputs, edges and update iterations are capped. A returned residual
reports whether the fixed-point iteration approached convergence within its
cap. It neither builds semantic links nor learns embeddings.

`executive.mjs` maintains a goal, criteria, observed state, pending attempts and
expected effects independently of model prose. A possibly mutating action
invalidates earlier verification before dispatch. Evidence keeps immutable IDs,
scope, environment revision and action attribution. Contradictions are retained;
model claims and absent outcomes cannot certify completion. Known contradictory
receipts cannot be omitted to manufacture a positive learning signal.

The controller distinguishes an observed change in criterion status from losing
information through invalidation. Neither is a numeric measure of goal value.
Repeated interventions with no new criterion evidence request replanning;
declared observation-only polling does not increment that intervention counter.
An EWMA tracks expected-effect reliability. Predictable polling is excluded from
the intervention ranking: predictable outcomes are not automatically useful
actions. The host must supply goal-relevant candidate interventions; this is not
a learned general-purpose value function or a calibrated probability model.

The bounded event journal supports validated JSON replay, including pending
attempts and unresolved evidence. A scope mismatch, invalid event or byte/event
limit fails explicitly. Admission checks snapshot capacity before changing state.
It does not implement disk transactions, distributed coordination or authenticated
event transport. Hosts own those boundaries.

## Mechanism ablations through the SDK

`sdk-probe.mjs` supplies one hand-authored environment and the same scripted
proposal sequence to five variants. The request cap is seven in every variant;
actual requests differ and are reported. Two operations return transport success
while leaving the fixture unhealthy. A third can repair it, and a separate
observation can verify health.

| Variant | Component removed | Intended falsification |
| --- | --- | --- |
| Baseline | No additional executive hooks | Plausible final prose can coexist with an unmet objective. |
| Without association | No links beyond the direct cue | The alternative procedure is unavailable to action selection even after the current strategy fails. |
| Without outcome control | No feedback into strategy selection | Recording failed expectations alone cannot change the next admitted action. |
| Without completion gate | No evidence-based answer review | Replanning support alone cannot prevent a premature closing answer. |
| Full | Neither removal | Outcomes change the selected strategy; a separate current observation permits completion. |

These labels describe variants of this fixture, not baselines from a published
benchmark. The real SDK executes tools, limits, step shaping and answer review.
The proposal generator is scripted; it is not an LLM performance comparison.
`run.status` is recorded separately from the controller's `verified` result.
The adapter independently inspects final evidence because `reviewAnswer` fails
open on callback errors and is not used on every termination path.

The full adapter retrieves candidate procedures through the scoped graph, then
uses observed effect reliability to select among host-admitted interventions.
Links make the alternative available; the outcome loop changes which one is
used. The graph tests also include a shuffled-link negative control. Links are
hand-authored, and no result here shows that automatically generated links
improve real tasks. Evaluating that coupling on held-out tasks remains work to do.

## Measurements and limits

The SDK probe reports request counts, executed tools, control decisions, wall
time, CPU time and serialized controller bytes. `resource-probe.mjs` measures
100 graph queries after five warmups over 256 nodes and 1,024 edges. It reports
p50/p95 time, CPU time, whole-process peak RSS and numerical residual. These are
local algorithm costs, excluding document indexing, embedding inference and
model reasoning. They are not deployment latency promises.

The executive uses scalar criteria, a single conservative environment revision,
one pending action and host-assigned provenance. Retained textual constraints
are not semantically interpreted or enforced; the host must encode enforceable
conditions and keep the SDK's permission policy. It has no general language
goal parser, learned world model, concurrent evidence commit protocol, automatic
procedure synthesis, validated long-term consolidation or integrated production
checkpoint storage. The design page describes those responsibilities without
claiming that this experiment implements them.

Before production integration, compare real tasks with identical model, effort,
permissions, initial state and total resource caps. Separate tuning from
chronological held-out tasks. Include stale evidence, distractors, task changes,
legitimate retries and adversarial memories. Measure completion and unsupported
claims alongside retrieval quality and total cost. Synthetic transition tests
are necessary checks, not evidence of general intelligence.
