import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolRegistryContract } from "../../types/tool/index.js";
import type {
	LLMToolSchema,
	ToolAvailability,
	ToolDefinition,
} from "../../types/tool/index.js";
import type {
	ToolCatalogEntry,
	ToolCatalogSearchResult,
	ToolCatalogSnapshot,
	ToolLoadingMode,
	ToolSource,
	ToolsetDefinition,
	ToolsetPolicy,
} from "../../types/toolset/index.js";

export interface ToolCatalogSearchOptions {
	readonly loading?: readonly ToolLoadingMode[];
	readonly limit?: number;
}

export interface ToolCatalogFromRegistryOptions {
	readonly source?: ToolSource;
	readonly toolset?: Omit<ToolsetDefinition, "sourceId"> & {
		readonly sourceId?: string;
	};
}

const DEFAULT_HOST_SOURCE: ToolSource = {
	id: "host-tools",
	kind: "host_tool",
	name: "Host tools",
	description: "Tools executed by the host runtime.",
};

const DEFAULT_HOST_TOOLSET: ToolsetDefinition = {
	id: "host-tools",
	sourceId: DEFAULT_HOST_SOURCE.id,
	name: "Host tools",
	defaultPolicy: {
		enabled: true,
		loading: "eager",
		permissionPolicy: "default",
	},
};

export class ToolCatalog {
	private sources = new Map<string, ToolSource>();
	private toolsets = new Map<string, ToolsetDefinition>();
	private tools = new Map<string, ToolCatalogEntry>();

	registerSource(source: ToolSource): void {
		this.sources.set(source.id, source);
	}

	registerToolset(toolset: ToolsetDefinition): void {
		if (!this.sources.has(toolset.sourceId)) {
			throw new Error(
				`Toolset "${toolset.id}" references unknown source "${toolset.sourceId}"`,
			);
		}
		this.toolsets.set(toolset.id, toolset);
	}

	registerTool(tool: ToolCatalogEntry): void {
		if (!this.sources.has(tool.sourceId)) {
			throw new Error(
				`Tool "${tool.name}" references unknown source "${tool.sourceId}"`,
			);
		}
		if (!this.toolsets.has(tool.toolsetId)) {
			throw new Error(
				`Tool "${tool.name}" references unknown toolset "${tool.toolsetId}"`,
			);
		}
		this.tools.set(tool.name, tool);
	}

	getSource(id: string): ToolSource | undefined {
		return this.sources.get(id);
	}

	getToolset(id: string): ToolsetDefinition | undefined {
		return this.toolsets.get(id);
	}

	getTool(name: string): ToolCatalogEntry | undefined {
		return this.tools.get(name);
	}

	listSources(): ToolSource[] {
		return [...this.sources.values()];
	}

	listToolsets(): ToolsetDefinition[] {
		return [...this.toolsets.values()];
	}

	listTools(): ToolCatalogEntry[] {
		return [...this.tools.values()];
	}

	snapshot(): ToolCatalogSnapshot {
		return {
			sources: this.listSources(),
			toolsets: this.listToolsets(),
			tools: this.listTools(),
		};
	}

	getToolsByLoading(loading: readonly ToolLoadingMode[]): ToolCatalogEntry[] {
		const wanted = new Set(loading);
		return this.listTools().filter((tool) =>
			wanted.has(resolveToolLoading(tool.policy)),
		);
	}

	searchTools(
		query: string,
		options: ToolCatalogSearchOptions = {},
	): ToolCatalogSearchResult[] {
		const normalized = query.trim().toLowerCase();
		const terms = normalized.split(/\s+/).filter(Boolean);
		const loading = options.loading ? new Set(options.loading) : null;
		const results: ToolCatalogSearchResult[] = [];

		for (const tool of this.listTools()) {
			if (loading && !loading.has(resolveToolLoading(tool.policy))) continue;
			if (tool.policy.enabled === false) continue;

			const source = this.sources.get(tool.sourceId);
			const toolset = this.toolsets.get(tool.toolsetId);
			if (!source || !toolset) continue;

			const scored = scoreToolSearch({
				terms,
				tool,
				source,
				toolset,
			});
			if (scored.score <= 0) continue;

			results.push({
				tool,
				source,
				toolset,
				score: scored.score,
				matched: scored.matched,
			});
		}

		results.sort(
			(a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
		);
		return results.slice(0, options.limit ?? 5);
	}

	toLLMTools(
		options: { readonly loading?: readonly ToolLoadingMode[] } = {},
	): LLMToolSchema[] {
		const loading = options.loading ?? ["eager"];
		return this.getToolsByLoading(loading)
			.filter((tool) => tool.policy.enabled !== false)
			.map((tool) => tool.llmSchema ?? toolDefinitionToLLMTool(tool.definition))
			.filter((tool): tool is LLMToolSchema => Boolean(tool));
	}
}

export function createToolCatalogFromRegistry(
	registry: ToolRegistryContract,
	options: ToolCatalogFromRegistryOptions = {},
): ToolCatalog {
	const source = options.source ?? DEFAULT_HOST_SOURCE;
	const toolset: ToolsetDefinition = {
		...DEFAULT_HOST_TOOLSET,
		...options.toolset,
		sourceId: options.toolset?.sourceId ?? source.id,
	};
	const catalog = new ToolCatalog();
	catalog.registerSource(source);
	catalog.registerToolset(toolset);

	for (const definition of registry.getAll()) {
		const availability = registry.getAvailability(definition.name);
		catalog.registerTool(
			toolDefinitionToCatalogEntry(definition, {
				availability,
				sourceId: source.id,
				toolsetId: toolset.id,
				toolsetPolicy: toolset.defaultPolicy,
			}),
		);
	}

	return catalog;
}

export function toolDefinitionToCatalogEntry(
	definition: ToolDefinition,
	input: {
		readonly availability?: ToolAvailability;
		readonly sourceId: string;
		readonly toolsetId: string;
		readonly toolsetPolicy?: ToolsetPolicy;
	},
): ToolCatalogEntry {
	const loading = loadingFromAvailability(input.availability ?? "active");
	return {
		name: definition.name,
		description: definition.description,
		sourceId: input.sourceId,
		toolsetId: input.toolsetId,
		definition,
		permissions: definition.permissions,
		category: definition.category,
		policy: {
			...input.toolsetPolicy,
			enabled:
				input.toolsetPolicy?.enabled === false
					? false
					: loading !== "suspended",
			loading,
		},
	};
}

export function loadingFromAvailability(
	availability: ToolAvailability,
): ToolLoadingMode {
	switch (availability) {
		case "deferred":
			return "deferred";
		case "suspended":
			return "suspended";
		default:
			return "eager";
	}
}

function resolveToolLoading(policy: ToolsetPolicy): ToolLoadingMode {
	if (policy.enabled === false) return "disabled";
	return policy.loading ?? "eager";
}

function toolDefinitionToLLMTool(
	definition: ToolDefinition | undefined,
): LLMToolSchema | null {
	if (!definition) return null;
	return {
		type: "function",
		function: {
			name: definition.name,
			description: definition.description,
			parameters: zodToJsonSchema(definition.inputSchema, {
				target: "jsonSchema7",
				$refStrategy: "none",
			}) as Record<string, unknown>,
		},
	};
}

function scoreToolSearch(input: {
	readonly terms: readonly string[];
	readonly tool: ToolCatalogEntry;
	readonly source: ToolSource;
	readonly toolset: ToolsetDefinition;
}): { score: number; matched: string[] } {
	const terms = input.terms.length > 0 ? input.terms : [""];
	const matched = new Set<string>();
	let score = 0;

	for (const term of terms) {
		if (!term) continue;

		const toolName = input.tool.name.toLowerCase();
		const description = input.tool.description.toLowerCase();
		const sourceText =
			`${input.source.name} ${input.source.description ?? ""} ${input.source.kind}`.toLowerCase();
		const toolsetText =
			`${input.toolset.name} ${input.toolset.description ?? ""}`.toLowerCase();

		if (toolName === term) {
			score += 12;
			matched.add("name");
		} else if (toolName.includes(term)) {
			score += 8;
			matched.add("name");
		}
		if (description.includes(term)) {
			score += 5;
			matched.add("description");
		}
		if (sourceText.includes(term)) {
			score += 3;
			matched.add("source");
		}
		if (toolsetText.includes(term)) {
			score += 2;
			matched.add("toolset");
		}
	}

	if (input.tool.policy.preferred && score > 0) score += 1;

	return {
		score,
		matched: [...matched],
	};
}
