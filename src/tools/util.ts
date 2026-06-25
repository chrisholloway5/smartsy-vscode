import * as vscode from "vscode";
import * as path from "path";

export const MAX_FILE_BYTES = 200_000;

export function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/**
 * Resolve a user/model-supplied path against the workspace root, refusing
 * anything that escapes it. Keeps the agent confined to the open project.
 */
export function resolveInWorkspace(root: vscode.Uri | undefined, p: string): vscode.Uri {
  if (!root) throw new Error("No workspace folder is open.");
  const abs = path.isAbsolute(p) ? p : path.join(root.fsPath, p);
  const norm = path.normalize(abs);
  const rootNorm = path.normalize(root.fsPath);
  if (norm !== rootNorm && !norm.startsWith(rootNorm + path.sep)) {
    throw new Error(`Path escapes the workspace: ${p}`);
  }
  return vscode.Uri.file(norm);
}

export function rel(root: vscode.Uri | undefined, uri: vscode.Uri): string {
  if (!root) return uri.fsPath;
  return path.relative(root.fsPath, uri.fsPath) || ".";
}

export function cap(s: string, n: number): { text: string; truncated: boolean } {
  return s.length <= n ? { text: s, truncated: false } : { text: s.slice(0, n), truncated: true };
}
