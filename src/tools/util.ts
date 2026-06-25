import * as vscode from "vscode";
import * as path from "path";

export const MAX_FILE_BYTES = 200_000;

export function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

export function primaryRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function within(rootFs: string, targetFs: string): boolean {
  const root = path.normalize(rootFs);
  const target = path.normalize(targetFs);
  return target === root || target.startsWith(root + path.sep);
}

function joinInRoot(root: vscode.Uri, relPath: string): vscode.Uri {
  const abs = path.normalize(path.join(root.fsPath, relPath));
  if (!within(root.fsPath, abs)) throw new Error(`Path escapes the workspace: ${relPath}`);
  return vscode.Uri.file(abs);
}

/**
 * Resolve a model/user-supplied path against the open workspace. Supports:
 *  - absolute paths that fall inside one of the workspace folders,
 *  - "<folderName>/rel/path" to target a specific folder when multi-root,
 *  - "rel/path" against the first (primary) folder.
 * Throws if the result escapes every workspace folder.
 */
export function resolveInWorkspace(p: string): vscode.Uri {
  const folders = workspaceFolders();
  if (folders.length === 0) throw new Error("No workspace folder is open.");

  if (path.isAbsolute(p)) {
    const norm = path.normalize(p);
    for (const f of folders) if (within(f.uri.fsPath, norm)) return vscode.Uri.file(norm);
    throw new Error(`Path escapes the workspace: ${p}`);
  }

  if (folders.length > 1) {
    const seg = p.split(/[\\/]/)[0];
    const named = folders.find((f) => f.name === seg);
    if (named) return joinInRoot(named.uri, p.slice(seg.length).replace(/^[\\/]/, ""));
  }
  return joinInRoot(folders[0].uri, p);
}

/**
 * Label a uri relative to its containing workspace folder. With multiple
 * roots the label is prefixed with the folder name so paths stay unambiguous.
 */
export function rel(uri: vscode.Uri): string {
  const folders = workspaceFolders();
  for (const f of folders) {
    if (within(f.uri.fsPath, uri.fsPath)) {
      const r = path.relative(f.uri.fsPath, uri.fsPath) || ".";
      return folders.length > 1 ? `${f.name}/${r}` : r;
    }
  }
  return uri.fsPath;
}

export function cap(s: string, n: number): { text: string; truncated: boolean } {
  return s.length <= n ? { text: s, truncated: false } : { text: s.slice(0, n), truncated: true };
}
