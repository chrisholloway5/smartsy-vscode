// Streaming client for Smartsy's /api/chat SSE endpoint.
//
// Wire format (from the server):
//   data: {meta}                 first event: { conversationId?, tools?, ... }
//   data: {"r":"…"}              reasoning delta
//   data: {"t":"…"}              assistant text delta
//   event: done\ndata: [DONE]    terminator
//
// Request body: { content, history:[{role,content}], model?, temporary }

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export interface StreamOptions {
  baseUrl: string;
  apiKey: string;
  content: string;
  history: ChatMessage[];
  model?: string;
  signal?: AbortSignal;
}

export interface StreamCallbacks {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onMeta?: (meta: Record<string, unknown>) => void;
}

export class SmartsyError extends Error {}

/**
 * Streams one assistant turn. Resolves with the full assistant text once the
 * stream terminates. Throws SmartsyError with a human-readable message on any
 * non-2xx response or transport failure.
 */
export async function streamChat(
  opts: StreamOptions,
  cb: StreamCallbacks = {}
): Promise<{ text: string; reasoning: string }> {
  const url = `${opts.baseUrl}/api/chat`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        content: opts.content,
        history: opts.history,
        model: opts.model || undefined,
        temporary: true,
      }),
      signal: opts.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") throw e;
    throw new SmartsyError(`Could not reach Smartsy at ${url}: ${e?.message || e}`);
  }

  if (!res.ok || !res.body) {
    throw new SmartsyError(await describeError(res));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of rawEvent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let json: any;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          if (typeof json.t === "string") {
            text += json.t;
            cb.onText?.(json.t);
          } else if (typeof json.r === "string") {
            reasoning += json.r;
            cb.onReasoning?.(json.r);
          } else if (json && typeof json === "object") {
            cb.onMeta?.(json);
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return { text, reasoning };
}

async function describeError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  let parsed: any = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* plain text */
  }
  if (parsed?.message) return `Smartsy: ${parsed.message}`;
  if (parsed?.error) return `Smartsy error (${res.status}): ${parsed.error}`;
  if (res.status === 401) {
    return "Smartsy rejected the API key (401). Run “Smartsy: Set API Key”.";
  }
  const snippet = body.replace(/\s+/g, " ").slice(0, 200);
  return `Smartsy request failed (${res.status})${snippet ? `: ${snippet}` : ""}`;
}
