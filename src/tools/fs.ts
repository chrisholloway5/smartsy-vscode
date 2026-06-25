import * as vscode from "vscode";
import { Tool } from "./types";
import { resolveInWorkspace, rel, cap, MAX_FILE_BYTES } from "./util";
import { makePreview } from "../preview";

async function readText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}

export const readFile: Tool = {
  name: "readFile",
  readonly: true,
  async run(args, ctx) {
    const uri = resolveInWorkspace(ctx.workspaceRoot, String(args.path || ""));
    const raw = await readText(uri);
    const limit =
      typeof args.maxBytes === "number" && args.maxBytes > 0 && args.maxBytes < MAX_FILE_BYTES
        ? args.maxBytes
        : MAX_FILE_BYTES;
    const { text, truncated } = cap(raw, limit);
    return { path: rel(ctx.workspaceRoot, uri), truncated, content: text };
  },
};

export const listDir: Tool = {
  name: "listDir",
  readonly: true,
  async run(args, ctx) {
    const uri = resolveInWorkspace(ctx.workspaceRoot, String(args.path || "."));
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return {
      path: rel(ctx.workspaceRoot, uri),
      entries: entries
        .map(([name, type]) => ({
          name,
          type:
            type === vscode.FileType.Directory
              ? "dir"
              : type === vscode.FileType.File
              ? "file"
              : "other",
        }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1)),
    };
  },
};

export const search: Tool = {
  name: "search",
  readonly: true,
  async run(args, ctx) {
    const query = String(args.query || "");
    if (!query) throw new Error("search requires a 'query'.");
    const glob = typeof args.glob === "string" && args.glob ? args.glob : "**/*";
    const maxResults = Math.min(Number(args.maxResults) || 60, 200);
    const re = args.isRegex ? new RegExp(query, "i") : null;
    const needle = query.toLowerCase();
    const files = await vscode.workspace.findFiles(
      glob,
      "**/{node_modules,.git,dist,.next,out,build,coverage}/**",
      800
    );
    const matches: Array<{ file: string; line: number; text: string }> = [];
    for (const f of files) {
      if (matches.length >= maxResults) break;
      let content: string;
      try {
        content = await readText(f);
      } catch {
        continue;
      }
      if (content.length > MAX_FILE_BYTES) content = content.slice(0, MAX_FILE_BYTES);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle);
        if (hit) {
          matches.push({ file: rel(ctx.workspaceRoot, f), line: i + 1, text: lines[i].slice(0, 300).trim() });
          if (matches.length >= maxResults) break;
        }
      }
    }
    return { query, count: matches.length, matches };
  },
};

export const createFile: Tool = {
  name: "createFile",
  readonly: false,
  async run(args, ctx) {
    const uri = resolveInWorkspace(ctx.workspaceRoot, String(args.path || ""));
    const content = String(args.content ?? "");
    const label = rel(ctx.workspaceRoot, uri);
    let exists = true;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      exists = false;
    }
    if (exists && !args.overwrite) {
      return { error: `File already exists: ${label}. Use editFile, or pass overwrite:true.` };
    }
    const modifiedUri = makePreview(label, content).toString();
    const originalUri = exists ? uri.toString() : makePreview("(new file)", "").toString();
    const approved = await ctx.requestApproval({
      title: `${exists ? "Overwrite" : "Create"} ${label}`,
      detail: `${content.length} bytes`,
      diff: { originalUri, modifiedUri, title: `${exists ? "Overwrite" : "Create"} ${label}` },
    });
    if (!approved) return { ok: false, denied: true };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    return { ok: true, path: label, bytes: content.length };
  },
};

export const editFile: Tool = {
  name: "editFile",
  readonly: false,
  async run(args, ctx) {
    const uri = resolveInWorkspace(ctx.workspaceRoot, String(args.path || ""));
    const label = rel(ctx.workspaceRoot, uri);
    const find = String(args.find ?? "");
    const replace = String(args.replace ?? "");
    if (!find) return { error: "editFile requires a non-empty 'find' string." };
    let original: string;
    try {
      original = await readText(uri);
    } catch {
      return { error: `Cannot read ${label} — use createFile for new files.` };
    }
    const occurrences = original.split(find).length - 1;
    if (occurrences === 0) {
      return { error: `'find' not present in ${label}. Re-read the file and match the text exactly (including whitespace).` };
    }
    if (occurrences > 1 && !args.replaceAll) {
      return { error: `'find' matches ${occurrences} times in ${label}; add surrounding context to make it unique, or pass replaceAll:true.` };
    }
    const modified = args.replaceAll ? original.split(find).join(replace) : original.replace(find, replace);
    const modifiedUri = makePreview(label, modified).toString();
    const approved = await ctx.requestApproval({
      title: `Edit ${label}`,
      detail: `${args.replaceAll ? occurrences : 1} replacement${(args.replaceAll ? occurrences : 1) === 1 ? "" : "s"}`,
      diff: { originalUri: uri.toString(), modifiedUri, title: `Edit ${label}` },
    });
    if (!approved) return { ok: false, denied: true };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(modified, "utf8"));
    return { ok: true, path: label, replacements: args.replaceAll ? occurrences : 1 };
  },
};
