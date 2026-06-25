import hljs from "highlight.js/lib/common";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };

interface ToolItem {
  kind: "tool";
  name: string;
  args: unknown;
  result: unknown;
}
type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; reasoning?: string }
  | ToolItem
  | { kind: "error"; text: string };

const vscode = acquireVsCodeApi();
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const messagesEl = $("messages");
const statusEl = $("status");
const form = $("composer") as HTMLFormElement;
const input = $("input") as HTMLTextAreaElement;
const sendBtn = $("send");
const stopBtn = $("stop");

let current: { wrap: HTMLElement; body: HTMLElement; raw: string; reasoning: string } | null = null;
const toolEls = new Map<string, HTMLElement>();

// ---------- markdown + highlighting ----------
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
function highlight(code: string, lang: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}
function inlineMd(s: string): string {
  let h = escapeHtml(s);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  h = h.replace(/\n/g, "<br>");
  return h;
}
function renderMarkdown(text: string): string {
  const parts = String(text).split(/```/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const block = parts[i];
      const nl = block.indexOf("\n");
      const lang = nl >= 0 ? block.slice(0, nl).trim() : "";
      const code = nl >= 0 ? block.slice(nl + 1) : block;
      html += '<pre class="code hljs"><code>' + highlight(code.replace(/\n$/, ""), lang) + "</code></pre>";
    } else if (parts[i]) {
      html += inlineMd(parts[i]);
    }
  }
  return html;
}
function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function addMessage(role: string): { wrap: HTMLElement; body: HTMLElement } {
  const wrap = document.createElement("div");
  wrap.className = "msg " + role;
  const body = document.createElement("div");
  body.className = "body";
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  scrollDown();
  return { wrap, body };
}

// ---------- streaming assistant bubble ----------
function ensureAssistant() {
  if (!current) {
    const m = addMessage("assistant");
    current = { wrap: m.wrap, body: m.body, raw: "", reasoning: "" };
  }
  return current;
}
// Hide <tool_call> protocol markup while streaming so raw JSON never flashes in
// the bubble (complete blocks removed; a dangling unclosed tag is clipped).
function sanitizeStream(raw: string): string {
  let s = raw.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "");
  const open = s.lastIndexOf("<tool_call>");
  if (open >= 0 && s.indexOf("</tool_call>", open) < 0) s = s.slice(0, open);
  return s;
}
function onDelta(text: string) {
  const a = ensureAssistant();
  a.raw += text;
  a.body.innerHTML = renderMarkdown(sanitizeStream(a.raw));
  scrollDown();
}
function onReasoning(text: string) {
  const a = ensureAssistant();
  a.reasoning += text;
  let r = a.wrap.querySelector(".reasoning") as HTMLElement | null;
  if (!r) {
    r = document.createElement("div");
    r.className = "reasoning";
    a.wrap.insertBefore(r, a.body);
  }
  r.textContent = a.reasoning;
  scrollDown();
}
function finalizeAssistant(cleaned: string) {
  const a = ensureAssistant();
  a.body.innerHTML = renderMarkdown(cleaned || sanitizeStream(a.raw));
  if (!(cleaned || "").trim() && !a.wrap.querySelector(".reasoning")) a.wrap.remove();
  current = null;
  scrollDown();
}

// ---------- tool cards ----------
function shortArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 79) + "…" : s;
  } catch {
    return "";
  }
}
function summarize(name: string, result: any): { cls: string; label: string } {
  if (!result || typeof result !== "object") return { cls: "ok", label: "done" };
  if (result.denied) return { cls: "denied", label: "denied" };
  if (result.error) return { cls: "err", label: String(result.error) };
  if (result.ok && result.path) return { cls: "ok", label: "✓ " + result.path };
  if (name === "search") return { cls: "ok", label: (result.count ?? 0) + " matches" };
  if (name === "readFile") return { cls: "ok", label: "read " + (result.path || "") };
  if (typeof result.exitCode === "number") return { cls: result.exitCode === 0 ? "ok" : "err", label: "exit " + result.exitCode };
  return { cls: "ok", label: "done" };
}
function makeToolCard(name: string, args: unknown): HTMLElement {
  const el = document.createElement("div");
  el.className = "tool running";
  el.innerHTML =
    '<span class="dot"></span><span class="tname"></span> <span class="targs"></span>' +
    '<span class="tstate">running…</span><pre class="tbody" hidden></pre>';
  (el.querySelector(".tname") as HTMLElement).textContent = name;
  (el.querySelector(".targs") as HTMLElement).textContent = shortArgs(args);
  el.addEventListener("click", () => {
    const b = el.querySelector(".tbody") as HTMLElement;
    if (b.textContent) b.hidden = !b.hidden;
  });
  return el;
}
function setToolResult(el: HTMLElement, name: string, result: unknown) {
  el.classList.remove("running");
  const s = summarize(name, result);
  el.classList.add(s.cls);
  (el.querySelector(".tstate") as HTMLElement).textContent = s.label;
  try {
    (el.querySelector(".tbody") as HTMLElement).textContent = JSON.stringify(result, null, 2);
  } catch {
    /* ignore */
  }
}
function onTool(id: string, name: string, args: unknown) {
  const el = makeToolCard(name, args);
  messagesEl.appendChild(el);
  toolEls.set(id, el);
  scrollDown();
}
function onToolResult(id: string, name: string, result: unknown) {
  const el = toolEls.get(id);
  if (el) setToolResult(el, name, result);
  scrollDown();
}

// ---------- approvals ----------
function onApproval(req: any) {
  const wrap = document.createElement("div");
  wrap.className = "approval";
  const h = document.createElement("div");
  h.className = "atitle";
  h.textContent = req.title;
  wrap.appendChild(h);
  if (req.detail) {
    const d = document.createElement("div");
    d.className = "adetail";
    d.textContent = req.detail;
    wrap.appendChild(d);
  }
  if (req.command) {
    const pre = document.createElement("pre");
    pre.className = "code";
    pre.textContent = req.command;
    wrap.appendChild(pre);
  }
  if (req.hasDiff) {
    const note = document.createElement("div");
    note.className = "adetail";
    note.textContent = "Diff opened in the editor — review it, then choose:";
    wrap.appendChild(note);
  }
  const row = document.createElement("div");
  row.className = "arow";
  const yes = document.createElement("button");
  yes.className = "approve";
  yes.textContent = "Approve";
  const no = document.createElement("button");
  no.className = "deny";
  no.textContent = "Deny";
  const decide = (approved: boolean) => {
    vscode.postMessage({ type: "approvalResponse", id: req.id, approved });
    yes.disabled = no.disabled = true;
    wrap.classList.add(approved ? "approved" : "denied");
    h.textContent = (approved ? "✓ " : "✗ ") + req.title;
  };
  yes.onclick = () => decide(true);
  no.onclick = () => decide(false);
  row.append(yes, no);
  wrap.appendChild(row);
  messagesEl.appendChild(wrap);
  scrollDown();
}

function showKeyBanner(baseUrl: string) {
  const wrap = document.createElement("div");
  wrap.className = "banner";
  wrap.innerHTML = "<div>Connect to <b>" + escapeHtml(baseUrl) + "</b> to start.</div>";
  const b = document.createElement("button");
  b.textContent = "Set API Key";
  b.onclick = () => vscode.postMessage({ type: "setApiKey" });
  wrap.appendChild(b);
  messagesEl.appendChild(wrap);
}

function setBusy(busy: boolean) {
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  if (!busy) statusEl.hidden = true;
}

function restore(items: TranscriptItem[]) {
  messagesEl.innerHTML = "";
  current = null;
  toolEls.clear();
  for (const it of items) {
    if (it.kind === "user") addMessage("user").body.textContent = it.text;
    else if (it.kind === "assistant") {
      const a = addMessage("assistant");
      if (it.reasoning) {
        const r = document.createElement("div");
        r.className = "reasoning";
        r.textContent = it.reasoning;
        a.wrap.insertBefore(r, a.body);
      }
      a.body.innerHTML = renderMarkdown(it.text);
    } else if (it.kind === "error") addMessage("error").body.textContent = it.text;
    else if (it.kind === "tool") {
      const el = makeToolCard(it.name, it.args);
      messagesEl.appendChild(el);
      setToolResult(el, it.name, it.result);
    }
  }
  scrollDown();
}

// ---------- @-file mentions ----------
const mentionBox = document.createElement("div");
mentionBox.className = "mentions";
mentionBox.hidden = true;
document.body.appendChild(mentionBox);
let mention = { open: false, start: -1, items: [] as string[], index: 0 };
let mentionTimer: ReturnType<typeof setTimeout> | undefined;

function activeMention(): { start: number; query: string } | null {
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}
function closeMention() {
  mention.open = false;
  mention.start = -1;
  mentionBox.hidden = true;
  mentionBox.innerHTML = "";
}
function renderMentions() {
  mentionBox.innerHTML = "";
  mention.items.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "mrow" + (i === mention.index ? " sel" : "");
    row.textContent = p;
    row.onmousedown = (e) => {
      e.preventDefault();
      acceptMention(p);
    };
    mentionBox.appendChild(row);
  });
  mentionBox.hidden = mention.items.length === 0;
  mention.open = mention.items.length > 0;
}
function acceptMention(path: string) {
  if (mention.start < 0) return;
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, mention.start);
  const after = input.value.slice(pos);
  const insert = "@" + path + " ";
  input.value = before + insert + after;
  const np = (before + insert).length;
  input.setSelectionRange(np, np);
  closeMention();
  input.focus();
  autosize();
}
function updateMention() {
  const m = activeMention();
  if (!m) {
    closeMention();
    return;
  }
  mention.start = m.start;
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(() => vscode.postMessage({ type: "mentionQuery", query: m.query }), 120);
}

// ---------- inbound ----------
window.addEventListener("message", (e) => {
  const m = e.data;
  switch (m.type) {
    case "config":
      if (!m.hasKey) showKeyBanner(m.baseUrl);
      break;
    case "restore":
      restore(m.items as TranscriptItem[]);
      break;
    case "userMessage":
      addMessage("user").body.textContent = m.text;
      break;
    case "delta":
      onDelta(m.text);
      break;
    case "reasoning":
      onReasoning(m.text);
      break;
    case "assistantMessage":
      finalizeAssistant(m.text);
      break;
    case "tool":
      onTool(m.id, m.name, m.args);
      break;
    case "toolResult":
      onToolResult(m.id, m.name, m.result);
      break;
    case "approval":
      onApproval(m);
      break;
    case "status":
      statusEl.textContent = m.text;
      statusEl.hidden = false;
      break;
    case "busy":
      setBusy(m.value);
      break;
    case "error":
      addMessage("error").body.textContent = m.text;
      break;
    case "clear":
      messagesEl.innerHTML = "";
      current = null;
      toolEls.clear();
      break;
    case "mentionResults":
      mention.items = (m.items as string[]) || [];
      mention.index = 0;
      renderMentions();
      break;
    case "focusInput":
      input.focus();
      break;
  }
});

// ---------- composer ----------
function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}
input.addEventListener("input", () => {
  autosize();
  updateMention();
});
input.addEventListener("keydown", (e) => {
  if (mention.open) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      mention.index = (mention.index + 1) % mention.items.length;
      renderMentions();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      mention.index = (mention.index - 1 + mention.items.length) % mention.items.length;
      renderMentions();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      acceptMention(mention.items[mention.index]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  closeMention();
  vscode.postMessage({ type: "send", text });
  input.value = "";
  autosize();
});
stopBtn.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));

vscode.postMessage({ type: "ready" });
input.focus();
