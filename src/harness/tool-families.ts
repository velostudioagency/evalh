import { HarnessError } from "../errors.ts";

/** Built-in pi tool names, in the order pi declares them. */
export const PI_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

/**
 * OMP tools that can be backed by pi's local tool implementations without the OMP
 * ToolSession runtime. OMP-only tools (task, eval, lsp, web_search, todo, ...) need
 * that runtime and are intentionally excluded in v0.2.0.
 */
export const OMP_PORTABLE_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find"] as const;

/**
 * Offered pi tools on this platform. Invoking powershell off Windows throws, so it
 * is only offered there; PI_TOOL_NAMES stays the full reference list.
 */
export function piToolNames(): string[] {
	if (process.platform === "win32") return [...PI_TOOL_NAMES];
	return PI_TOOL_NAMES.filter((name) => name !== "powershell");
}

export function resolveToolNames(family: string, configured: string[] | undefined): string[] | undefined {
	if (configured && configured.length > 0) return [...configured];

	switch (family) {
		case "pi":
			return piToolNames();
		case "omp":
			return [...OMP_PORTABLE_TOOL_NAMES];
		case "custom":
			return undefined;
		default:
			throw new HarnessError(
				"tool_family_unknown",
				`Unknown tool family "${family}"`,
				"Use one of: pi, omp, custom.",
			);
	}
}
