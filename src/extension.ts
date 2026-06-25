import * as vscode from "vscode";
import { ChatViewProvider } from "./panel/ChatViewProvider";
import { PREVIEW_SCHEME, previewProvider } from "./preview";

export function activate(context: vscode.ExtensionContext): void {
  // Virtual docs used to render proposed edits in a diff editor.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previewProvider)
  );

  const provider = new ChatViewProvider(context.extensionUri, context.secrets);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("smartsy.newChat", () => provider.newChat()),
    vscode.commands.registerCommand("smartsy.setApiKey", () => provider.runSetApiKey()),
    vscode.commands.registerCommand("smartsy.setBaseUrl", () => provider.runSetBaseUrl()),
    vscode.commands.registerCommand("smartsy.focusChat", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.smartsy");
      provider.focusInput();
    })
  );
}

export function deactivate(): void {
  /* nothing to clean up beyond context.subscriptions */
}
