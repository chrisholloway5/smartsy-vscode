import * as vscode from "vscode";

export interface ApprovalRequest {
  title: string;
  detail?: string;
  /** A shell command to display verbatim (runCommand). */
  command?: string;
  /** When present, the panel opens a native diff editor before asking. */
  diff?: { originalUri: string; modifiedUri: string; title: string };
}

export interface ToolContext {
  workspaceRoot?: vscode.Uri;
  autoApproveReads: boolean;
  /** Resolves true if the user approves the action, false if they deny. */
  requestApproval: (req: ApprovalRequest) => Promise<boolean>;
  /** Append a line to the agent output channel (e.g. command output). */
  log: (msg: string) => void;
}

export interface Tool {
  name: string;
  /** Read-only tools may auto-run; writes/commands always request approval. */
  readonly: boolean;
  run(args: any, ctx: ToolContext): Promise<unknown>;
}
