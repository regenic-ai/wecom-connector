import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  messageCursor,
  parseWeComCallback,
  type WeComChatMode,
  type WeComConversation,
  type WeComInboundMessage,
} from "./wecom-message";

const MAX_MESSAGES_PER_CONVERSATION = 200;

interface StoredConversation {
  conversation_id: string;
  name?: string;
  chat_mode?: WeComChatMode;
  peer_user_id?: string;
  last_at: number;
}

interface InboxFile {
  conversations: Record<string, StoredConversation>;
  messages: Record<string, WeComInboundMessage[]>;
}

const memory = new Map<string, InboxFile>();
let rootOverride: string | undefined;

export function setWeComInboxRootForTests(root?: string): void {
  rootOverride = root?.trim() || undefined;
  memory.clear();
}

export function clearWeComInboxForTests(): void {
  memory.clear();
  if (!rootOverride) {
    return;
  }
  rmSync(rootOverride, { recursive: true, force: true });
}

export function clearAllWeComInboxes(): void {
  memory.clear();
  try {
    rmSync(resolveRoot(), { recursive: true, force: true });
  } catch {
    // A missing cache is already clear.
  }
}

export function acceptWeComFrame(
  botId: string,
  raw: unknown,
  receivedAt?: number,
): boolean {
  const message = parseWeComCallback(raw, receivedAt);
  if (!message) {
    return false;
  }
  rememberWeComMessage(botId, message);
  return true;
}

export function rememberWeComMessage(botId: string, message: WeComInboundMessage): void {
  const inbox = load(botId);
  const current = inbox.messages[message.conversation_id] ?? [];
  if (!current.some((item) => item.msg_id === message.msg_id)) {
    current.push(message);
    current.sort(compareMessages);
    inbox.messages[message.conversation_id] = current.slice(-MAX_MESSAGES_PER_CONVERSATION);
  }
  const prev = inbox.conversations[message.conversation_id];
  inbox.conversations[message.conversation_id] = {
    conversation_id: message.conversation_id,
    name: message.conversation_title || prev?.name,
    chat_mode: message.chat_mode ?? prev?.chat_mode,
    peer_user_id: message.peer_user_id ?? prev?.peer_user_id,
    last_at: Math.max(prev?.last_at ?? 0, message.create_at),
  };
  save(botId, inbox);
}

export function listWeComMessages(
  botId: string,
  conversationId: string,
  after: string | undefined,
  limit: number,
): WeComInboundMessage[] {
  const list = load(botId).messages[conversationId] ?? [];
  const filtered = after
    ? list.filter((message) => messageCursor(message) > after)
    : list;
  return filtered.slice(0, limit);
}

export function listWeComConversations(
  botId: string,
  kinds?: readonly WeComChatMode[],
): WeComConversation[] {
  return Object.values(load(botId).conversations)
    .filter((chat) => !kinds || !chat.chat_mode || kinds.includes(chat.chat_mode))
    .sort((left, right) =>
      right.last_at - left.last_at || left.conversation_id.localeCompare(right.conversation_id),
    )
    .map(toConversation);
}

export function summarizeWeComInbox(botId: string): {
  exists: boolean;
  conversation_count: number;
  message_count: number;
} {
  const inbox = load(botId);
  return {
    exists: existsSync(filePath(botId)),
    conversation_count: Object.keys(inbox.conversations).length,
    message_count: Object.values(inbox.messages).reduce(
      (count, messages) => count + messages.length,
      0,
    ),
  };
}

export function describeWeComConversation(
  botId: string,
  conversationId: string,
): WeComConversation | undefined {
  const chat = load(botId).conversations[conversationId];
  return chat ? toConversation(chat) : undefined;
}

function toConversation(chat: StoredConversation): WeComConversation {
  return {
    conversation_id: chat.conversation_id,
    ...(chat.name ? { name: chat.name } : {}),
    ...(chat.chat_mode ? { chat_mode: chat.chat_mode } : {}),
    ...(chat.peer_user_id ? { peer_user_id: chat.peer_user_id } : {}),
  };
}

function compareMessages(left: WeComInboundMessage, right: WeComInboundMessage): number {
  return left.create_at - right.create_at || left.msg_id.localeCompare(right.msg_id);
}

function load(botId: string): InboxFile {
  const cached = memory.get(botId);
  if (cached) {
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath(botId), "utf8")) as Partial<InboxFile>;
    const inbox: InboxFile = {
      conversations: parsed.conversations ?? {},
      messages: parsed.messages ?? {},
    };
    memory.set(botId, inbox);
    return inbox;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    const inbox: InboxFile = { conversations: {}, messages: {} };
    memory.set(botId, inbox);
    return inbox;
  }
}

function save(botId: string, inbox: InboxFile): void {
  memory.set(botId, inbox);
  const path = filePath(botId);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(inbox));
  renameSync(temporary, path);
}

function filePath(botId: string): string {
  return join(resolveRoot(), `${safeSegment(botId)}.json`);
}

function resolveRoot(): string {
  if (rootOverride) {
    return rootOverride;
  }
  const env = process.env.REGENIC_WECOM_INBOX_DIR?.trim();
  if (env) {
    return env;
  }
  const home = process.env.REGENIC_HOME?.trim() || join(homedir(), ".regenic");
  return join(home, "wecom-inbox");
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "x";
}
