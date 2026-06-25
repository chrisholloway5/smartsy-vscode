# Smartsy for VS Code

An agentic coding chat in your editor, powered by your [Smartsy](https://smartsy-ai.com) server — a Claude-Code-style assistant that can read, search, edit, and run your project, with you approving every change.

It talks to Smartsy's existing `/api/chat` endpoint over SSE, authenticated with a Smartsy API key. No server changes required: the coding toolset is injected client-side and the agent drives the `<tool_call>` loop the Smartsy backend already understands.

## Features

- **Chat sidebar** with streaming replies (and reasoning, when the model emits it).
- **Codebase-aware tools** the model can call:
  - `readFile`, `listDir`, `search`, `activeEditor`, `diagnostics` (read-only, auto-run)
  - `editFile`, `createFile` — shown as a **native diff you approve** before anything is written
  - `runCommand` — build/test/git in the workspace, **with your approval**, output fed back to the model
- **You're in control:** reads run automatically; every write and shell command requires an explicit Approve/Deny. The agent is confined to the open workspace folder.

## Setup

1. **Build the extension**
   ```bash
   npm install
   npm run build
   ```
2. **Run it:** open this folder in VS Code and press `F5` (Extension Development Host), or package a VSIX with `npm run package` and install it.
3. **Configure:**
   - Open the **Smartsy** view from the activity bar.
   - Run **“Smartsy: Set Server URL”** if your server isn't `https://smartsy-ai.com`.
   - Run **“Smartsy: Set API Key”** (or click *Set API Key* in the panel) and paste a key that starts with `sk_`. Create one in the Smartsy admin panel under **Users → API keys**.

## Settings

| Setting | Default | Description |
|---|---|---|
| `smartsy.baseUrl` | `https://smartsy-ai.com` | Server base URL; the extension calls `<baseUrl>/api/chat`. |
| `smartsy.model` | `""` | Model id to request; blank uses the server default. |
| `smartsy.maxToolIterations` | `12` | Max tool round-trips per message. |
| `smartsy.autoApproveReads` | `true` | Auto-run read-only tools. Writes/commands always ask. |

The API key is stored in VS Code **SecretStorage**, never in settings.

## How it works

```
VS Code extension ──POST /api/chat (Bearer sk_…)──▶ Smartsy server ──▶ LLM
        ▲   parse <tool_call> · execute in workspace · reply [tool_results]  │
        └──────────────────────── SSE stream ─────────────────────────────┘
```

The conversation is primed with a coding-tools description; the model emits
`<tool_call>{ "name", "args" }</tool_call>` blocks, the extension runs them
against your workspace (with approval for writes/commands), and replies with a
`[tool_results]` message — looping until the model gives a final answer.

## Status

MVP. Single workspace folder, exact-string edits, light Markdown rendering.
Roadmap: multi-root workspaces, richer diffs, @-file mentions, conversation
history, and user-facing API-key minting in the Smartsy account UI.
