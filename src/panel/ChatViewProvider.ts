import * as vscode from "vscode";
import { Agent, primerHistory } from "../agent";
import { ApprovalRequest } from "../tools/types";
import { resolveInWorkspace, rel } from "../tools/util";
import { ConversationStore, Conversation, deriveTitle } from "../store";
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
const ACTIVE_KEY = "smartsy.activeConversationId";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "smartsy.chatView";

  private readonly extensionUri: vscode.Uri;
  private readonly secrets: vscode.SecretStorage;
  private readonly store: ConversationStore;
  private readonly output: vscode.OutputChannel;

  private view?: vscode.WebviewView;
  private agent?: Agent;
  private agentKey = "";
  private agentConvId = "";
  private conv?: Conversation;
  private busy = false;
  private abort?: AbortController;
  private readonly pendingApprovals = new Map<string, (ok: boolean) => void>();
  private readonly pendingTools = new Map<string, { name: string; args: unknown }>();
  private approvalSeq = 0;
  private turnReasoning = "";

  constructor(private readonly context: vscode.ExtensionContext) {
    this.extensionUri = context.extensionUri;
    this.secrets = context.secrets;
    this.store = new ConversationStore(context.globalState);
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
      this.cancelPendingApprovals();
      this.abort?.abort();
    });
  }

  private cancelPendingApprovals(): void {
    for (const resolve of this.pendingApprovals.values()) resolve(false);
    this.pendingApprovals.clear();
  }

  focusInput(): void {
    this.view?.show?.(true);
    this.post({ type: "focusInput" });
  }

  newChat(): void {
    this.abort?.abort();
    this.cancelPendingApprovals();
    void this.startNewConversation();
  }

  async showHistory(): Promise<void> {
    const items = this.store.list();
    if (!items.length) {
      void vscode.window.showInformationMessage("No saved Smartsy conversations yet.");
      return;
    }
    const picks = items.map((c) => ({
      label: c.title,
      description: relTime(c.updatedAt),
      detail: `${c.transcript.length} messages`,
      id: c.id,
    }));
    const pick = await vscode.window.showQuickPick(picks, {
      title: "Smartsy conversations",
      placeHolder: "Switch to a previous conversation",
    });
    if (pick) await this.switchTo(pick.id);
  }

  async runSetApiKey(): Promise<void> {
    const key = await promptForApiKey(this.secrets);
    if (key) {
      this.agent = undefined;
      await this.postConfig();
    }
  }

  async runSetBaseUrl(): Promise<void> {
    await promptForBaseUrl();
    this.agent = undefined;
    await this.postConfig();
  }

  // ---------- message handling ----------
  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case "ready":
        await this.ensureConversation();
        await this.postConfig();
        this.post({ type: "restore", items: this.conv?.transcript ?? [] });
        break;
      case "send":
        await this.handleSend(String(msg.text || ""));
        break;
      case "cancel":
        this.abort?.abort();
        this.cancelPendingApprovals();
        break;
      case "newChat":
        this.newChat();
        break;
      case "setApiKey":
        await this.runSetApiKey();
        break;
      case "mentionQuery":
        await this.handleMentionQuery(String(msg.query || ""));
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
    const conv = await this.ensureConversation();
    const agent = this.syncAgent(apiKey, conv);

    this.busy = true;
    this.abort = new AbortController();
    this.pendingTools.clear();
    this.post({ type: "userMessage", text });
    this.post({ type: "busy", value: true });

    conv.transcript.push({ kind: "user", text });
    if (conv.title === "New chat") conv.title = deriveTitle(text);
    this.turnReasoning = "";

    const expanded = await this.expandMentions(text);

    try {
      await agent.runTurn(
        expanded,
        {
          onText: (d) => this.post({ type: "delta", text: d }),
          onReasoning: (d) => {
            this.turnReasoning += d;
            this.post({ type: "reasoning", text: d });
          },
          onAssistantMessage: (full) => {
            this.post({ type: "assistantMessage", text: full });
            if (full.trim()) {
              const reasoning = this.turnReasoning.trim() || undefined;
              conv.transcript.push({ kind: "assistant", text: full, reasoning });
            }
            this.turnReasoning = "";
          },
          onToolCall: (id, name, args) => {
            this.pendingTools.set(id, { name, args });
            this.post({ type: "tool", id, name, args });
          },
          onToolResult: (id, result) => {
            const p = this.pendingTools.get(id);
            this.post({ type: "toolResult", id, name: p?.name, result });
            conv.transcript.push({ kind: "tool", name: p?.name ?? "tool", args: p?.args, result });
          },
          onStatus: (s) => this.post({ type: "status", text: s }),
        },
        this.abort.signal
      );
    } catch (e: any) {
      if (e?.name === "AbortError") {
        this.post({ type: "status", text: "Stopped." });
      } else {
        const text2 = e?.message || String(e);
        this.post({ type: "error", text: text2 });
        conv.transcript.push({ kind: "error", text: text2 });
      }
    } finally {
      this.busy = false;
      this.post({ type: "busy", value: false });
      conv.history = agent.getHistory();
      await this.store.save(conv, Date.now());
    }
  }

  // ---------- @-file mentions ----------
  private async handleMentionQuery(query: string): Promise<void> {
    const glob = query ? `**/*${query}*` : "**/*";
    const files = await vscode.workspace.findFiles(
      glob,
      "**/{node_modules,.git,dist,.next,out,build}/**",
      24
    );
    const items = files
      .map((f) => rel(f))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, 12);
    this.post({ type: "mentionResults", items });
  }

  private async expandMentions(text: string): Promise<string> {
    const re = /(^|\s)@([^\s]+)/g;
    const paths = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // Trim trailing sentence punctuation so "@src/app.ts." resolves.
      const p = m[2].replace(/[.,;:!?)\]}'"]+$/, "");
      if (p) paths.add(p);
    }
    if (!paths.size) return text;
    const blocks: string[] = [];
    const missing: string[] = [];
    for (const p of paths) {
      try {
        const uri = resolveInWorkspace(p);
        const bytes = await vscode.workspace.fs.readFile(uri);
        let content = Buffer.from(bytes).toString("utf8");
        if (content.length > 20_000) content = content.slice(0, 20_000) + "\n…(truncated)";
        blocks.push("Attached file " + rel(uri) + ":\n```\n" + content + "\n```");
      } catch {
        missing.push(p);
      }
    }
    if (missing.length) {
      // Surface unresolved mentions instead of silently dropping them.
      this.post({ type: "status", text: `Couldn't attach: ${missing.join(", ")}` });
    }
    if (!blocks.length && !missing.length) return text;
    let preface = "";
    if (blocks.length) preface += `[The user attached these files for context]\n\n${blocks.join("\n\n")}\n\n`;
    if (missing.length) preface += `[Note: these @mentions could not be found and were not attached: ${missing.join(", ")}]\n\n`;
    return `${preface}---\n\n${text}`;
  }

  // ---------- conversation lifecycle ----------
  private async ensureConversation(): Promise<Conversation> {
    if (this.conv) return this.conv;
    const activeId = this.context.globalState.get<string>(ACTIVE_KEY);
    const existing = activeId ? this.store.get(activeId) : undefined;
    if (existing) {
      this.conv = existing;
    } else {
      this.conv = this.store.create(primerHistory(), Date.now());
      await this.store.save(this.conv, Date.now());
      await this.context.globalState.update(ACTIVE_KEY, this.conv.id);
    }
    return this.conv;
  }

  private async persistCurrent(): Promise<void> {
    if (!this.conv) return;
    if (this.agent && this.agentConvId === this.conv.id) this.conv.history = this.agent.getHistory();
    await this.store.save(this.conv, Date.now());
  }

  private async startNewConversation(): Promise<void> {
    await this.persistCurrent();
    this.conv = this.store.create(primerHistory(), Date.now());
    await this.store.save(this.conv, Date.now());
    await this.context.globalState.update(ACTIVE_KEY, this.conv.id);
    this.agentConvId = "";
    this.post({ type: "clear" });
  }

  private async switchTo(id: string): Promise<void> {
    const target = this.store.get(id);
    if (!target) return;
    await this.persistCurrent();
    this.conv = target;
    await this.context.globalState.update(ACTIVE_KEY, id);
    this.agentConvId = "";
    this.post({ type: "restore", items: target.transcript });
  }

  private syncAgent(apiKey: string, conv: Conversation): Agent {
    if (!this.agent || this.agentKey !== apiKey) {
      this.agent = new Agent({
        baseUrl: getBaseUrl(),
        apiKey,
        model: getModel(),
        maxIterations: getMaxToolIterations(),
        autoApproveReads: getAutoApproveReads(),
        requestApproval: (req) => this.requestApproval(req),
        log: (msg) => this.output.appendLine(msg),
      });
      this.agentKey = apiKey;
      this.agentConvId = "";
    }
    if (this.agentConvId !== conv.id) {
      this.agent.loadHistory(conv.history);
      this.agentConvId = conv.id;
    }
    return this.agent;
  }

  // ---------- approvals ----------
  private requestApproval = async (req: ApprovalRequest): Promise<boolean> => {
    // If the turn was already cancelled, don't even prompt.
    if (this.abort?.signal.aborted) return false;
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
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(id, resolve);
      // Resolve as a denial if the user hits Stop while this is outstanding,
      // so the agent loop unwinds and `busy` is cleared.
      const signal = this.abort?.signal;
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            this.pendingApprovals.delete(id);
            resolve(false);
          },
          { once: true }
        );
      }
    });
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
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f));
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
    <textarea id="input" rows="1" placeholder="Ask Smartsy… (@ to attach a file)" autocomplete="off"></textarea>
    <button id="send" type="submit" title="Send">Send</button>
    <button id="stop" type="button" title="Stop" hidden>Stop</button>
  </form>
  <script nonce="${nonce}" src="${uri("webview.js")}"></script>
</body>
</html>`;
  }
}

function relTime(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function getNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
