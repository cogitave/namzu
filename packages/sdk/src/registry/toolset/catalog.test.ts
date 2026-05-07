import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ToolDefinition } from "../../types/tool/index.js";
import { ToolRegistry } from "../tool/execute.js";
import { ToolCatalog, createToolCatalogFromRegistry } from "./catalog.js";

function makeTool(name: string, description = `${name} tool`): ToolDefinition {
	return {
		name,
		description,
		inputSchema: z.object({ query: z.string().optional() }),
		async execute() {
			return { success: true, output: `${name}-ran` };
		},
	};
}

describe("ToolCatalog", () => {
	it("keeps sources, toolsets, and tools as separate records", () => {
		const catalog = new ToolCatalog();
		catalog.registerSource({
			id: "mcp:microsoft-learn",
			kind: "mcp_server",
			name: "Microsoft Learn",
			mcpServer: {
				name: "microsoft-learn",
				url: "https://learn.microsoft.com/api/mcp",
				transport: "streamable_http",
			},
		});
		catalog.registerToolset({
			id: "mcp-toolset:microsoft-learn",
			sourceId: "mcp:microsoft-learn",
			name: "Microsoft Learn toolset",
			defaultPolicy: {
				enabled: true,
				loading: "deferred",
				preferred: true,
				permissionPolicy: "always_allow",
			},
		});
		catalog.registerTool({
			name: "microsoft_docs_search",
			description: "Search Microsoft documentation",
			sourceId: "mcp:microsoft-learn",
			toolsetId: "mcp-toolset:microsoft-learn",
			policy: { enabled: true, loading: "deferred", preferred: true },
		});

		expect(catalog.listSources()).toHaveLength(1);
		expect(catalog.listToolsets()).toHaveLength(1);
		expect(catalog.getToolsByLoading(["deferred"]).map((t) => t.name)).toEqual([
			"microsoft_docs_search",
		]);
	});

	it("searches deferred tools by name, description, source, and toolset", () => {
		const registry = new ToolRegistry();
		registry.register(
			makeTool("github_search_issues", "Search repository issues"),
			"deferred",
		);
		registry.register(
			makeTool("slack_search_messages", "Search team messages"),
			"deferred",
		);
		registry.register(makeTool("bash", "Run a shell command"));

		const catalog = createToolCatalogFromRegistry(registry, {
			source: {
				id: "host",
				kind: "host_tool",
				name: "Host runtime",
				description: "Local shell and collaboration tools",
			},
			toolset: {
				id: "default-host",
				name: "Default host tools",
				defaultPolicy: { enabled: true, loading: "eager" },
			},
		});

		expect(
			catalog
				.searchTools("repository", { loading: ["deferred"] })
				.map((r) => r.tool.name),
		).toEqual(["github_search_issues"]);
		expect(catalog.toLLMTools().map((t) => t.function.name)).toEqual(["bash"]);
	});

	it("preserves registry availability as catalog loading policy", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool("read_file"));
		registry.register(makeTool("web_search"), "deferred");
		registry.register(makeTool("write_file"), "suspended");

		const catalog = createToolCatalogFromRegistry(registry);

		expect(catalog.getTool("read_file")?.policy.loading).toBe("eager");
		expect(catalog.getTool("web_search")?.policy.loading).toBe("deferred");
		expect(catalog.getTool("write_file")?.policy.loading).toBe("suspended");
		expect(catalog.toLLMTools({ loading: ["suspended"] })).toEqual([]);
	});
});
