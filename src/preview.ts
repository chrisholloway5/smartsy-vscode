import * as vscode from "vscode";

/** Virtual scheme used to show proposed file content in a diff editor. */
export const PREVIEW_SCHEME = "smartsy-diff";

const store = new Map<string, string>();
const MAX_PREVIEWS = 40;
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
  // Bound memory: drop the oldest previews once we exceed the cap (Map keeps
  // insertion order, so the first key is the oldest).
  while (store.size > MAX_PREVIEWS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: id });
}
