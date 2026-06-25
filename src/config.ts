import * as vscode from "vscode";

const API_KEY_SECRET = "smartsy.apiKey";

/** Reads the configured server base URL, normalised (no trailing slash). */
export function getBaseUrl(): string {
  const raw = vscode.workspace
    .getConfiguration("smartsy")
    .get<string>("baseUrl", "https://smartsy-ai.com");
  return raw.replace(/\/+$/, "");
}

export function getModel(): string {
  return vscode.workspace.getConfiguration("smartsy").get<string>("model", "").trim();
}

export function getMaxToolIterations(): number {
  const n = vscode.workspace.getConfiguration("smartsy").get<number>("maxToolIterations", 12);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 12;
}

export function getAutoApproveReads(): boolean {
  return vscode.workspace.getConfiguration("smartsy").get<boolean>("autoApproveReads", true);
}

export async function getApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  return secrets.get(API_KEY_SECRET);
}

export async function setApiKey(secrets: vscode.SecretStorage, key: string): Promise<void> {
  await secrets.store(API_KEY_SECRET, key.trim());
}

export async function clearApiKey(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(API_KEY_SECRET);
}

/** Prompt the user for an API key and persist it. Returns the key or undefined. */
export async function promptForApiKey(
  secrets: vscode.SecretStorage
): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: "Smartsy API Key",
    prompt: "Paste a Smartsy API key (starts with sk_). Create one in the Smartsy admin panel under Users → API keys.",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "sk_…",
    validateInput: (v) =>
      v.trim().startsWith("sk_") ? null : "Smartsy API keys start with 'sk_'.",
  });
  if (!key) return undefined;
  await setApiKey(secrets, key);
  return key.trim();
}

export async function promptForBaseUrl(): Promise<void> {
  const current = getBaseUrl();
  const url = await vscode.window.showInputBox({
    title: "Smartsy Server URL",
    prompt: "Base URL of your Smartsy server (the extension calls <baseUrl>/api/chat).",
    value: current,
    ignoreFocusOut: true,
    validateInput: (v) =>
      /^https?:\/\//.test(v.trim()) ? null : "Enter a full http(s):// URL.",
  });
  if (!url) return;
  await vscode.workspace
    .getConfiguration("smartsy")
    .update("baseUrl", url.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global);
}
