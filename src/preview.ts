import * as vscode from "vscode";

/** Virtual scheme used to show proposed file content in a diff editor. */
export const PREVIEW_SCHEME = "smartsy-diff";

const store = new Map<string, string>();
let seq = 0;

export const previewProvider: vscode.TextDocumentContentProvider = {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return store.get(uri.path) ?? "";
  },
};

/** Stash proposed content and return a uri the diff editor can render. */
export function makePreview(filename: string, content: string): vscode.Uri {
  const safe = filename.replace(/[^A-Za-z0-9._/-]/g, "_");
  const id = `/${seq++}/${safe}`;
  store.set(id, content);
  return vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: id });
}
