// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const statusEl = document.getElementById("status");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const stopBtn = document.getElementById("stop");

  let current = null; // { wrap, body, raw, reasoning } for the streaming assistant bubble
  const toolEls = new Map();

  // ---------- helpers ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function inlineMd(s) {
    let h = escapeHtml(s);
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    h = h.replace(/\n/g, "<br>");
    return h;
  }
  function renderMarkdown(text) {
    const parts = String(text).split(/```/);
    let html = "";
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        const block = parts[i];
        const nl = block.indexOf("\n");
        const code = nl >= 0 ? block.slice(nl + 1) : block;
        html += '<pre class="code"><code>' + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>";
      } else if (parts[i]) {
        html += inlineMd(parts[i]);
      }
    }
    return html;
  }
  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function addMessage(role) {
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
  function onDelta(text) {
    const a = ensureAssistant();
    a.raw += text;
    a.body.innerHTML = renderMarkdown(a.raw);
    scrollDown();
  }
  function onReasoning(text) {
    const a = ensureAssistant();
    a.reasoning += text;
    let r = a.wrap.querySelector(".reasoning");
    if (!r) {
      r = document.createElement("div");
      r.className = "reasoning";
      a.wrap.insertBefore(r, a.body);
    }
    r.textContent = a.reasoning;
    scrollDown();
  }
  function finalizeAssistant(cleaned) {
    const a = ensureAssistant();
    a.body.innerHTML = renderMarkdown(cleaned || a.raw);
    if (!(cleaned || "").trim() && !a.wrap.querySelector(".reasoning")) {
      a.wrap.remove(); // nothing but tool calls — drop the empty bubble
    }
    current = null;
    scrollDown();
  }

  // ---------- tool cards ----------
  function shortArgs(args) {
    try {
      const s = JSON.stringify(args);
      return s.length > 80 ? s.slice(0, 79) + "…" : s;
    } catch {
      return "";
    }
  }
  function onTool(id, name, args) {
    const el = document.createElement("div");
    el.className = "tool running";
    el.innerHTML =
      '<span class="dot"></span><span class="tname"></span> <span class="targs"></span>' +
      '<span class="tstate">running…</span><pre class="tbody" hidden></pre>';
    el.querySelector(".tname").textContent = name;
    el.querySelector(".targs").textContent = shortArgs(args);
    el.addEventListener("click", () => {
      const b = el.querySelector(".tbody");
      if (b.textContent) b.hidden = !b.hidden;
    });
    messagesEl.appendChild(el);
    toolEls.set(id, el);
    scrollDown();
  }
  function summarize(name, result) {
    if (!result || typeof result !== "object") return { cls: "ok", label: "done" };
    if (result.denied) return { cls: "denied", label: "denied" };
    if (result.error) return { cls: "err", label: String(result.error) };
    if (result.ok && result.path) return { cls: "ok", label: "✓ " + result.path };
    if (name === "search") return { cls: "ok", label: (result.count ?? 0) + " matches" };
    if (name === "readFile") return { cls: "ok", label: "read " + (result.path || "") };
    if (typeof result.exitCode === "number") return { cls: result.exitCode === 0 ? "ok" : "err", label: "exit " + result.exitCode };
    return { cls: "ok", label: "done" };
  }
  function onToolResult(id, name, result) {
    const el = toolEls.get(id);
    if (!el) return;
    el.classList.remove("running");
    const s = summarize(name, result);
    el.classList.add(s.cls);
    el.querySelector(".tstate").textContent = s.label;
    const body = el.querySelector(".tbody");
    try {
      body.textContent = JSON.stringify(result, null, 2);
    } catch {}
    scrollDown();
  }

  // ---------- approvals ----------
  function onApproval(req) {
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
    function decide(approved) {
      vscode.postMessage({ type: "approvalResponse", id: req.id, approved });
      yes.disabled = no.disabled = true;
      wrap.classList.add(approved ? "approved" : "denied");
      h.textContent = (approved ? "✓ " : "✗ ") + req.title;
    }
    yes.onclick = () => decide(true);
    no.onclick = () => decide(false);
    row.appendChild(yes);
    row.appendChild(no);
    wrap.appendChild(row);
    messagesEl.appendChild(wrap);
    scrollDown();
  }

  function showKeyBanner(baseUrl) {
    const wrap = document.createElement("div");
    wrap.className = "banner";
    wrap.innerHTML = "<div>Connect to <b>" + escapeHtml(baseUrl) + "</b> to start.</div>";
    const b = document.createElement("button");
    b.textContent = "Set API Key";
    b.onclick = () => vscode.postMessage({ type: "setApiKey" });
    wrap.appendChild(b);
    messagesEl.appendChild(wrap);
  }

  function setBusy(busy) {
    sendBtn.hidden = busy;
    stopBtn.hidden = !busy;
    input.disabled = false;
    if (!busy) statusEl.hidden = true;
  }

  // ---------- inbound ----------
  window.addEventListener("message", (e) => {
    const m = e.data;
    switch (m.type) {
      case "config":
        if (!m.hasKey) showKeyBanner(m.baseUrl);
        break;
      case "userMessage": {
        const um = addMessage("user");
        um.body.textContent = m.text;
        break;
      }
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
      case "error": {
        const em = addMessage("error");
        em.body.textContent = m.text;
        break;
      }
      case "clear":
        messagesEl.innerHTML = "";
        current = null;
        toolEls.clear();
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
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: "send", text });
    input.value = "";
    autosize();
  });
  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));

  vscode.postMessage({ type: "ready" });
  input.focus();
})();
