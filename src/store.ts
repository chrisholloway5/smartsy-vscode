import * as vscode from "vscode";
import { ChatMessage } from "./smartsyClient";

/** A renderable transcript item — mirrors what the webview draws, so a
 *  conversation can be fully restored after a reload. */
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; reasoning?: string }
  | { kind: "tool"; name: string; args: unknown; result: unknown }
  | { kind: "error"; text: string };

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  history: ChatMessage[]; // agent context (includes the primer pair)
  transcript: TranscriptItem[];
}

const KEY = "smartsy.conversations.v1";
const MAX_KEEP = 50;

function uid(now: number): string {
  return `${now.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function deriveTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 57) + "…" : t || "New chat";
}

export class ConversationStore {
  constructor(private state: vscode.Memento) {}

  private all(): Conversation[] {
    return this.state.get<Conversation[]>(KEY) ?? [];
  }

  /** Most-recently-updated first. */
  list(): Conversation[] {
    return this.all().slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Conversation | undefined {
    return this.all().find((c) => c.id === id);
  }

  create(history: ChatMessage[], now: number): Conversation {
    return { id: uid(now), title: "New chat", createdAt: now, updatedAt: now, history, transcript: [] };
  }

  async save(conv: Conversation, now: number): Promise<void> {
    const all = this.all();
    conv.updatedAt = now;
    const idx = all.findIndex((c) => c.id === conv.id);
    if (idx >= 0) all[idx] = conv;
    else all.push(conv);
    const trimmed = all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_KEEP);
    await this.state.update(KEY, trimmed);
  }

  async remove(id: string): Promise<void> {
    await this.state.update(KEY, this.all().filter((c) => c.id !== id));
  }
}
