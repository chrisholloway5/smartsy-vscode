import * as vscode from "vscode";
import { Tool } from "./types";
import { rel, cap, MAX_FILE_BYTES } from "./util";

export const activeEditor: Tool = {
  name: "activeEditor",
  readonly: true,
  async run(_args, ctx) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return { none: true, note: "No file is open in the editor." };
    const doc = ed.document;
    const sel = ed.selection;
    const full = cap(doc.getText(), MAX_FILE_BYTES);
    return {
      path: rel(ctx.workspaceRoot, doc.uri),
      languageId: doc.languageId,
      lineCount: doc.lineCount,
      selection: sel.isEmpty
        ? null
        : {
            startLine: sel.start.line + 1,
            endLine: sel.end.line + 1,
            text: cap(doc.getText(sel), 20_000).text,
          },
      content: full.text,
      truncated: full.truncated,
    };
  },
};

export const diagnostics: Tool = {
  name: "diagnostics",
  readonly: true,
  async run(args, ctx) {
    const sevName = (s: vscode.DiagnosticSeverity): string =>
      s === vscode.DiagnosticSeverity.Error
        ? "error"
        : s === vscode.DiagnosticSeverity.Warning
        ? "warning"
        : s === vscode.DiagnosticSeverity.Information
        ? "info"
        : "hint";
    const out: Array<{ file: string; severity: string; message: string; line: number }> = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      const label = rel(ctx.workspaceRoot, uri);
      if (args.path && label !== String(args.path)) continue;
      for (const d of diags) {
        out.push({ file: label, severity: sevName(d.severity), message: d.message, line: d.range.start.line + 1 });
        if (out.length >= 200) break;
      }
      if (out.length >= 200) break;
    }
    return { count: out.length, problems: out };
  },
};
