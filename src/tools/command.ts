import { exec } from "child_process";
import { Tool } from "./types";
import { resolveInWorkspace, rel, primaryRoot } from "./util";

export const runCommand: Tool = {
  name: "runCommand",
  readonly: false,
  async run(args, ctx) {
    const command = String(args.command || "").trim();
    if (!command) return { error: "runCommand requires a 'command'." };
    const cwdUri = args.cwd ? resolveInWorkspace(String(args.cwd)) : primaryRoot();
    const cwd = cwdUri?.fsPath;
    const approved = await ctx.requestApproval({
      title: "Run shell command",
      command,
      detail: cwdUri ? `in ${rel(cwdUri)}` : undefined,
    });
    if (!approved) return { ok: false, denied: true };
    ctx.log(`$ ${command}`);
    return await new Promise((resolve) => {
      exec(
        command,
        { cwd, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true },
        (err: any, stdout, stderr) => {
          const out = String(stdout || "").slice(0, 20_000);
          const errOut = String(stderr || "").slice(0, 20_000);
          if (out) ctx.log(out);
          if (errOut) ctx.log(errOut);
          // Node kills the child (err.killed) for BOTH the timeout and a
          // maxBuffer overflow (code "ENOBUFS"); distinguish the two.
          const bufferExceeded = err?.code === "ENOBUFS";
          resolve({
            exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
            timedOut: !!(err && err.killed && !bufferExceeded),
            bufferExceeded,
            stdout: out,
            stderr: errOut,
          });
        }
      );
    });
  },
};
