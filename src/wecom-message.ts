export const WECOM_SOURCE = "wecom";

export type WeComChatMode = "group" | "p2p";

export interface WeComConversation {
  conversation_id: string;
  name?: string;
  chat_mode?: WeComChatMode;
  peer_user_id?: string;
}

export interface WeComInboundMessage {
  msg_id: string;
  conversation_id: string;
  conversation_title?: string;
  chat_mode?: WeComChatMode;
  create_at: number;
  sender_id: string;
  sender_label?: string;
  peer_user_id?: string;
  text: string;
  msg_type: string;
}

export function messageCursor(message: {
  create_at: number;
  msg_id: string;
}): string {
  return `${String(Math.max(0, Math.trunc(message.create_at))).padStart(16, "0")}:${message.msg_id}`;
}

export function wecomConversationKind(
  chatMode: WeComChatMode | undefined,
): "group" | "direct" | undefined {
  if (chatMode === "p2p") {
    return "direct";
  }
  if (chatMode === "group") {
    return "group";
  }
  return undefined;
}

/**
 * Translate one WeCom long-connection message callback into an inbound message.
 * Events, media-only payloads, and the bot's own sender id are dropped.
 */
export function parseWeComCallback(
  raw: unknown,
  receivedAt = Date.now(),
): WeComInboundMessage | undefined {
  if (!isObject(raw) || raw.cmd !== "aibot_msg_callback" || !isObject(raw.body)) {
    return undefined;
  }
  const body = raw.body;
  const msgId = stringValue(body.msgid);
  const msgType = stringValue(body.msgtype);
  const chatMode = chatModeOf(stringValue(body.chattype));
  if (!msgId || !msgType || !chatMode) {
    return undefined;
  }
  const text = extractText(msgType, body);
  if (!text) {
    return undefined;
  }
  const senderId = senderOf(body.from);
  const botId = stringValue(body.aibotid);
  if (!senderId || (botId && senderId === botId)) {
    return undefined;
  }
  const conversationId = conversationIdOf(chatMode, body, senderId);
  if (!conversationId) {
    return undefined;
  }
  const title = cleanLabel(stringValue(body.conversation_title));
  const senderLabel = cleanLabel(stringValue(body.sender_name));
  return {
    msg_id: msgId,
    conversation_id: conversationId,
    ...(title ? { conversation_title: title } : {}),
    chat_mode: chatMode,
    create_at: timestampMs(body.create_time, receivedAt),
    sender_id: senderId,
    ...(senderLabel ? { sender_label: senderLabel } : {}),
    ...(chatMode === "p2p" ? { peer_user_id: senderId } : {}),
    text,
    msg_type: msgType,
  };
}

function extractText(msgType: string, body: Record<string, unknown>): string | undefined {
  if (msgType === "text" || msgType === "markdown") {
    return textContent(body[msgType]);
  }
  if (msgType === "voice") {
    return textContent(body.voice);
  }
  if (msgType === "mixed") {
    return mixedText(body.mixed);
  }
  return undefined;
}

function mixedText(value: unknown): string | undefined {
  if (!isObject(value) || !Array.isArray(value.msg_item)) {
    return undefined;
  }
  const parts = value.msg_item.flatMap((item) => {
    if (!isObject(item) || item.msgtype !== "text") {
      return [];
    }
    const text = textContent(item.text);
    return text ? [text] : [];
  });
  const joined = parts.join("\n").trim();
  return joined || undefined;
}

function textContent(value: unknown): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return stringValue(value.content);
}

function conversationIdOf(
  chatMode: WeComChatMode,
  body: Record<string, unknown>,
  senderId: string,
): string | undefined {
  if (chatMode === "group") {
    return stringValue(body.chatid);
  }
  return senderId;
}

function senderOf(value: unknown): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return stringValue(value.userid);
}

function chatModeOf(value: string | undefined): WeComChatMode | undefined {
  if (value === "single") {
    return "p2p";
  }
  if (value === "group") {
    return "group";
  }
  return undefined;
}

function timestampMs(value: unknown, fallback: number): number {
  const parsed = numberValue(value);
  if (parsed === undefined || parsed <= 0) {
    return Math.trunc(fallback);
  }
  const millis = parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
  return Math.trunc(millis);
}

function cleanLabel(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
