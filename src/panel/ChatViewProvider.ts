import * as vscode from "vscode";
import { Agent } from "../agent";
import { ApprovalRequest } from "../tools/types";
import { workspaceRoot } from "../tools/util";
import {
  getApiKey,
  getAutoApproveReads,
  getBaseUrl,
  getMaxToolIterations,
  getModel,
  promptForApiKey,
  promptForBaseUrl,
} from "../config";

type Outbound = Record<string, unknown> & { type: string };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "smartsy.chatView";

  private view?: vscode.WebviewView;
  private agent?: Agent;
  private agentKey = ""; // apiKey the current agent was built with
  private busy = false;
  private abort?: AbortController;
  private readonly output: vscode.OutputChannel;
  private readonly pendingApprovals = new Map<string, (ok: boolean) => void>();
  private approvalSeq = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage
  ) {
    this.output = vscode.window.createOutputChannel("Smartsy Agent");
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidDispose(() => {
      // Resolve any waiting approvals as denials so the agent can unwind.
      for (const resolve of this.pendingApprovals.values()) resolve(false);
      this.pendingApprovals.clear();
      this.abort?.abort();
    });
  }

  /** Focus the input (used by the "New Chat" / "Open Chat" commands). */
  focusInput(): void {
    this.view?.show?.(true);
    this.post({ type: "focusInput" });
  }

  newChat(): void {
    this.abort?.abort();
    this.agent?.reset();
    this.post({ type: "clear" });
  }

  async runSetApiKey(): Promise<void> {
    const key = await promptForApiKey(this.secrets);
    if (key) {
      this.agent = undefined; // rebuild with the new key
      await this.postConfig();
    }
  }

  async runSetBaseUrl(): Promise<void> {
    await promptForBaseUrl();
    this.agent = undefined;
    await this.postConfig();
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case "ready":
        await this.postConfig();
        break;
      case "send":
        await this.handleSend(String(msg.text || ""));
        break;
      case "cancel":
        this.abort?.abort();
        break;
      case "newChat":
        this.newChat();
        break;
      case "setApiKey":
        await this.runSetApiKey();
        break;
      case "approvalResponse": {
        const resolve = this.pendingApprovals.get(String(msg.id));
        if (resolve) {
          this.pendingApprovals.delete(String(msg.id));
          resolve(!!msg.approved);
        }
        break;
      }
    }
  }

  private async handleSend(text: string): Promise<void> {
    if (!text.trim() || this.busy) return;
    const apiKey = (await getApiKey(this.secrets)) || (await promptForApiKey(this.secrets));
    if (!apiKey) {
      this.post({ type: "error", text: "No Smartsy API key set — run “Smartsy: Set API Key”." });
      return;
    }

    const agent = this.ensureAgent(apiKey);
    this.busy = true;
    this.abort = new AbortController();
    this.post({ type: "userMessage", text });
    this.post({ type: "busy", value: true });

    try {
      await agent.runTurn(
        text,
        {
          onText: (d) => this.post({ type: "delta", text: d }),
          onReasoning: (d) => this.post({ type: "reasoning", text: d }),
          onAssistantMessage: (full) => this.post({ type: "assistantMessage", text: full }),
          onToolCall: (id, name, args) => this.post({ type: "tool", id, name, args }),
          onToolResult: (id, result) => this.post({ type: "toolResult", id, result }),
          onStatus: (s) => this.post({ type: "status", text: s }),
        },
        this.abort.signal
      );
    } catch (e: any) {
      if (e?.name === "AbortError") this.post({ type: "status", text: "Stopped." });
      else this.post({ type: "error", text: e?.message || String(e) });
    } finally {
      this.busy = false;
      this.post({ type: "busy", value: false });
    }
  }

  private ensureAgent(apiKey: string): Agent {
    if (this.agent && this.agentKey === apiKey) return this.agent;
    this.agent = new Agent({
      baseUrl: getBaseUrl(),
      apiKey,
      model: getModel(),
      maxIterations: getMaxToolIterations(),
      autoApproveReads: getAutoApproveReads(),
      workspaceRoot: workspaceRoot(),
      requestApproval: (req) => this.requestApproval(req),
      log: (m) => this.output.appendLine(m),
    });
    this.agentKey = apiKey;
    return this.agent;
  }

  private requestApproval = async (req: ApprovalRequest): Promise<boolean> => {
    const id = `ap-${this.approvalSeq++}`;
    if (req.diff) {
      try {
        await vscode.commands.executeCommand(
          "vscode.diff",
          vscode.Uri.parse(req.diff.originalUri),
          vscode.Uri.parse(req.diff.modifiedUri),
          req.diff.title,
          { preview: true } as vscode.TextDocumentShowOptions
        );
      } catch {
        /* diff is best-effort */
      }
    }
    this.post({
      type: "approval",
      id,
      title: req.title,
      detail: req.detail,
      command: req.command,
      hasDiff: !!req.diff,
    });
    return new Promise<boolean>((resolve) => this.pendingApprovals.set(id, resolve));
  };

  private async postConfig(): Promise<void> {
    const key = await getApiKey(this.secrets);
    this.post({ type: "config", hasKey: !!key, baseUrl: getBaseUrl() });
  }

  private post(msg: Outbound): void {
    this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const uri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${uri("style.css")}" rel="stylesheet" />
  <title>Smartsy</title>
</head>
<body>
  <div id="messages" class="messages"></div>
  <div id="status" class="status" hidden></div>
  <form id="composer" class="composer">
    <textarea id="input" rows="1" placeholder="Ask Smartsy to read, edit, or run something…" autocomplete="off"></textarea>
    <button id="send" type="submit" title="Send">Send</button>
    <button id="stop" type="button" title="Stop" hidden>Stop</button>
  </form>
  <script nonce="${nonce}" src="${uri("main.js")}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
