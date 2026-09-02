# Runtime

Runtime contracts and bounds a host relies on.

* [Test your own checkpoint store](checkpoint-store-conformance.md) - Run the shipped checkpoint-store contract against a backend you wrote yourself — what the suite guarantees, how to wire it to any test runner, the capability flags, and why the contract carries a version number.
* [The coding-agent doctrine](coding-agent-doctrine.md) - Put the kernel's rules for how a coding agent works into the system prompt as a static contribution, with the delegation rules separable for a sub-agent that has no Agent tool.
* [Duplex run lifetime](duplex-run-lifetime.md) - Reference for duplex-session ownership, the difference between conversational interruption and run cancellation, atomic tool-result publication, duplicate-call fencing, and bounded provider cleanup.
* [Provider capabilities and model input modalities](model-input-modalities.md) - Reference for the difference between a driver's ability to map rich input and the input kinds accepted by one listed model, including the honest meaning of absent model metadata.
* [Provider-native replay ownership](provider-native-replay.md) - Reference for assistant-message route provenance and versioned adapter replay state, including fallback attribution, resume behavior, validation, and safe degradation across provider or model switches.
* [Provider stream idle bounds](provider-stream-idle-bound.md) - Reference for the finite provider-stream silence bound, its relationship to run timeouts, retry and fallback composition, cancellation semantics, configuration limits, and the explicit compatibility opt-out.
* [RAG embedding request bounds](rag-embedding-request-bound.md) - Reference for HTTP embedding deadlines, response integrity, cancellation propagation across public RAG operations, transport ownership, and the explicit unbounded compatibility option.
* [Provider request rich-content budgets](request-rich-content-budget.md) - Reference for provider-bound image and document projection, including the accumulated payload budget, durable recovery after one rejected image, preserved history, and explicit unbounded compatibility mode.
* [Stored attachment resolution](stored-attachment-resolution.md) - Reference for resolving stored image and document references through SDK agent front doors, the finite materialization deadline, cancellation precedence, refusal semantics, and the explicit unbounded compatibility mode.
