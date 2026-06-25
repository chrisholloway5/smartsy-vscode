import { Tool, ToolContext } from "./types";
import { readFile, listDir, search, createFile, editFile } from "./fs";
import { activeEditor, diagnostics } from "./editor";
import { runCommand } from "./command";

const TOOLS: Tool[] = [readFile, listDir, search, activeEditor, diagnostics, editFile, createFile, runCommand];
const REGISTRY = new Map<string, Tool>(TOOLS.map((t) => [t.name, t]));
export const TOOL_NAMES = TOOLS.map((t) => t.name);

export async function runTool(name: string, args: any, ctx: ToolContext): Promise<unknown> {
  const tool = REGISTRY.get(name);
  if (!tool) {
    return { error: `Unknown tool '${name}'. Available: ${TOOL_NAMES.join(", ")}` };
  }
  try {
    // Read-only tools may auto-run unless the user disabled that; writes and
    // commands request approval inside their own run().
    if (tool.readonly && !ctx.autoApproveReads) {
      const ok = await ctx.requestApproval({
        title: `Run ${name}`,
        detail: JSON.stringify(args ?? {}).slice(0, 200),
      });
      if (!ok) return { ok: false, denied: true };
    }
    return await tool.run(args || {}, ctx);
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}

export type { Tool, ToolContext } from "./types";
