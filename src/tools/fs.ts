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
  async run(args) {
    const uri = resolveInWorkspace(String(args.path || ""));
    const raw = await readText(uri);
    const limit =
      typeof args.maxBytes === "number" && args.maxBytes > 0 && args.maxBytes < MAX_FILE_BYTES
        ? args.maxBytes
        : MAX_FILE_BYTES;
    const { text, truncated } = cap(raw, limit);
    return { path: rel(uri), truncated, content: text };
  },
};

export const listDir: Tool = {
  name: "listDir",
  readonly: true,
  async run(args) {
    const uri = resolveInWorkspace(String(args.path || "."));
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return {
      path: rel(uri),
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
  async run(args) {
    const query = String(args.query || "");
    if (!query) throw new Error("search requires a 'query'.");
    const glob = typeof args.glob === "string" && args.glob ? args.glob : "**/*";
    const maxResults = Math.min(Number(args.maxResults) || 60, 200);
    const re = args.isRegex ? new RegExp(query, "i") : null;
    const needle = query.toLowerCase();
    // findFiles spans every workspace folder automatically.
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
          matches.push({ file: rel(f), line: i + 1, text: lines[i].slice(0, 300).trim() });
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
    const uri = resolveInWorkspace(String(args.path || ""));
    const content = String(args.content ?? "");
    const label = rel(uri);
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

interface Hunk {
  find: string;
  replace: string;
  replaceAll?: boolean;
}

function normalizeEdits(args: any): Hunk[] | { error: string } {
  if (Array.isArray(args.edits) && args.edits.length) {
    const out: Hunk[] = [];
    for (const e of args.edits) {
      if (!e || typeof e.find !== "string" || !e.find) {
        return { error: "Each entry in 'edits' needs a non-empty 'find' string." };
      }
      out.push({ find: e.find, replace: String(e.replace ?? ""), replaceAll: !!e.replaceAll });
    }
    return out;
  }
  if (typeof args.find === "string" && args.find) {
    return [{ find: args.find, replace: String(args.replace ?? ""), replaceAll: !!args.replaceAll }];
  }
  return { error: "editFile requires either 'find'/'replace' or an 'edits' array." };
}

export const editFile: Tool = {
  name: "editFile",
  readonly: false,
  async run(args, ctx) {
    const uri = resolveInWorkspace(String(args.path || ""));
    const label = rel(uri);
    const edits = normalizeEdits(args);
    if ("error" in edits) return edits;

    let content: string;
    try {
      content = await readText(uri);
    } catch {
      return { error: `Cannot read ${label} — use createFile for new files.` };
    }

    // Validate & apply each hunk in order against the evolving content.
    let applied = 0;
    for (let i = 0; i < edits.length; i++) {
      const { find, replace, replaceAll } = edits[i];
      const occurrences = content.split(find).length - 1;
      if (occurrences === 0) {
        return { error: `edit #${i + 1}: 'find' not present in ${label} (after earlier edits). Re-read and match exactly, including whitespace.` };
      }
      if (occurrences > 1 && !replaceAll) {
        return { error: `edit #${i + 1}: 'find' matches ${occurrences} times in ${label}; add surrounding context to make it unique, or set replaceAll:true.` };
      }
      if (replaceAll) {
        content = content.split(find).join(replace);
        applied += occurrences;
      } else {
        // Splice by index so `replace` is inserted verbatim — String.replace
        // would interpret $$, $&, $`, $' patterns in the replacement string.
        const at = content.indexOf(find);
        content = content.slice(0, at) + replace + content.slice(at + find.length);
        applied += 1;
      }
    }

    const modifiedUri = makePreview(label, content).toString();
    const approved = await ctx.requestApproval({
      title: `Edit ${label}`,
      detail: `${edits.length} hunk${edits.length === 1 ? "" : "s"}, ${applied} replacement${applied === 1 ? "" : "s"}`,
      diff: { originalUri: uri.toString(), modifiedUri, title: `Edit ${label}` },
    });
    if (!approved) return { ok: false, denied: true };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    return { ok: true, path: label, hunks: edits.length, replacements: applied };
  },
};
