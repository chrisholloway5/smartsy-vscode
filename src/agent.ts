import * as vscode from "vscode";
import { streamChat, ChatMessage } from "./smartsyClient";
import { runTool } from "./tools";
import { ApprovalRequest, ToolContext } from "./tools/types";
import { CODING_TOOLS_PROMPT, PRIMER_ACK } from "./prompt";

export interface AgentDeps {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxIterations: number;
  autoApproveReads: boolean;
  workspaceRoot?: vscode.Uri;
  requestApproval: (req: ApprovalRequest) => Promise<boolean>;
  log: (msg: string) => void;
}

export interface TurnCallbacks {
  onText: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Fired when a streamed assistant message completes, with tool_call markup removed. */
  onAssistantMessage?: (cleaned: string) => void;
  onToolCall: (id: string, name: string, args: any) => void;
  onToolResult: (id: string, result: unknown) => void;
  onStatus?: (text: string) => void;
}

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

interface ParsedCall {
  name: string;
  args: any;
}

function parseToolCalls(text: string): { calls: ParsedCall[]; cleaned: string } {
  const calls: ParsedCall[] = [];
  let m: RegExpExecArray | null;
  TOOL_CALL_RE.lastIndex = 0;
  while ((m = TOOL_CALL_RE.exec(text))) {
    let raw = m[1].trim();
    // Tolerate the model wrapping the JSON in a code fence.
    raw = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.name === "string") {
        calls.push({ name: obj.name, args: obj.args ?? {} });
        continue;
      }
      calls.push({ name: "__parse_error__", args: { raw } });
    } catch {
      calls.push({ name: "__parse_error__", args: { raw } });
    }
  }
  const cleaned = text.replace(TOOL_CALL_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { calls, cleaned };
}

export class Agent {
  private history: ChatMessage[] = [];
  private readonly ctx: ToolContext;

  constructor(private deps: AgentDeps) {
    this.reset();
    this.ctx = {
      workspaceRoot: deps.workspaceRoot,
      autoApproveReads: deps.autoApproveReads,
      requestApproval: deps.requestApproval,
      log: deps.log,
    };
  }

  reset(): void {
    this.history = [
      { role: "user", content: CODING_TOOLS_PROMPT },
      { role: "assistant", content: PRIMER_ACK },
    ];
  }

  /** Run one user turn to completion (through any number of tool round-trips). */
  async runTurn(userText: string, cb: TurnCallbacks, signal: AbortSignal): Promise<void> {
    let content = userText;
    for (let i = 0; i < this.deps.maxIterations; i++) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

      const { text } = await streamChat(
        {
          baseUrl: this.deps.baseUrl,
          apiKey: this.deps.apiKey,
          content,
          history: this.history,
          model: this.deps.model,
          signal,
        },
        { onText: cb.onText, onReasoning: cb.onReasoning }
      );

      this.history.push({ role: "user", content });
      this.history.push({ role: "assistant", content: text });

      const { calls, cleaned } = parseToolCalls(text);
      cb.onAssistantMessage?.(cleaned);

      if (calls.length === 0) return; // final answer

      const results: Array<{ name: string; result: unknown }> = [];
      for (const call of calls) {
        const id = `${i}-${results.length}`;
        cb.onToolCall(id, call.name, call.args);
        let result: unknown;
        if (call.name === "__parse_error__") {
          result = {
            error:
              "Malformed <tool_call>. Emit one JSON object with string 'name' and object 'args', e.g. " +
              '<tool_call>{"name":"readFile","args":{"path":"src/x.ts"}}</tool_call>',
          };
        } else {
          result = await runTool(call.name, call.args, this.ctx);
        }
        cb.onToolResult(id, result);
        results.push({ name: call.name, result });
      }

      content = `[tool_results]\n${JSON.stringify(results, null, 2)}`;
      cb.onStatus?.("Working…");
    }

    cb.onAssistantMessage?.(
      "_Reached the tool-step limit for one message. Tell me to continue if there's more to do._"
    );
  }
}
