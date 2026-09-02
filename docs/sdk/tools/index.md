# Tools

Defining tools, the built-ins, safety, and delegates.

* [The ask_user_question tool](ask-user-question.md) - Give a run one tool that turns to the human for a decision, built alone from a park handler without the coordinator's gateway, roster, or a run id chosen before any run exists.
* [Built-In Tools](built-in.md) - Reference for the built-in tools exported by @namzu/sdk, including their purpose, safety shape, deadlines, and common usage patterns.
* [Code navigation — the call site grep cannot find](code-navigation.md) - Why an agent asked for call sites needs symbol resolution rather than a regex, what the three-member result union protects against, why the lsp tool is not registered without a provider, and how one server per language is routed by file extension.
* [SDK Tools](defining-tools.md) - Define tools, register them in ToolRegistry, and understand built-in tool behavior in @namzu/sdk.
* [Agents defined in files](file-defined-agents.md) - Load delegated sub-agents from Markdown files with frontmatter, shadow them by root order, filter their tool rosters read-only or by name, and ship the explore delegate.
* [Tool Safety](safety.md) - Layered tool safety in @namzu/sdk, including tool metadata, availability states, the authorization rule vocabulary and its evaluation order, plan mode, and sandbox boundaries.
