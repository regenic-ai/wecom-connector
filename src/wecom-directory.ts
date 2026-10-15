import type { ConversationThread, SyncCatalogMember } from "@regenic/connector-contract";
import type { WeComImClient } from "./wecom-client";
import {
  pickedConversationNames,
  wecomKinds,
  wecomPickedConversationIds,
  wecomSelection,
} from "./wecom-config";
import {
  WECOM_SOURCE,
  type WeComChatMode,
  type WeComConversation,
} from "./wecom-message";
import {
  WECOM_RECENT_LIMIT,
  wecomConversationIdFromStreamKey,
} from "./wecom-streams";

export type WeComDiscover = "known" | "recent" | "full";

export async function resolveWeComConversationTargets(
  config: Record<string, unknown>,
  client: WeComImClient,
  options: {
    known?: WeComConversation[];
    discover?: WeComDiscover;
  } = {},
): Promise<WeComConversation[]> {
  if (wecomSelection(config) === "pick") {
    return fillPickedConversations(config, client);
  }
  const kinds = wecomKinds(config);
  const known = (options.known ?? []).filter((conversation) =>
    matchesKinds(conversation, kinds),
  );
  const discover = options.discover ?? "recent";
  if (discover === "known") {
    return known;
  }
  let listed: WeComConversation[] = [];
  try {
    listed = await client.listRecentConversations(kinds);
  } catch {
    return known;
  }
  const capped = discover === "recent" ? listed.slice(0, WECOM_RECENT_LIMIT) : listed;
  return mergeConversations(known, capped);
}

export function wecomConversationsFromThreads(
  threads: readonly ConversationThread[],
  sourceMatches: (thread: ConversationThread) => boolean,
): WeComConversation[] {
  return threads.flatMap((thread) => {
    if (thread.source !== WECOM_SOURCE || !sourceMatches(thread)) {
      return [];
    }
    return [{ conversation_id: thread.target }];
  });
}

export function wecomConversationsFromCatalog(
  members: readonly SyncCatalogMember[],
): WeComConversation[] {
  return members.flatMap((member) => {
    const conversationId =
      wecomConversationIdFromStreamKey(member.stream_key) ??
      (member.thread_id?.startsWith(`${WECOM_SOURCE}:`)
        ? member.thread_id.slice(WECOM_SOURCE.length + 1)
        : undefined);
    if (!conversationId) {
      return [];
    }
    const name = member.label?.replace(/\s+/g, " ").trim();
    const kind =
      member.kind === "group" || member.kind === "p2p" ? member.kind : undefined;
    return [
      {
        conversation_id: conversationId,
        ...(name ? { name } : {}),
        ...(kind ? { chat_mode: kind } : {}),
      },
    ];
  });
}

function fillPickedConversations(
  config: Record<string, unknown>,
  client: WeComImClient,
): WeComConversation[] {
  const ids = wecomPickedConversationIds(config);
  const names = pickedConversationNames(config, ids);
  return ids.map((conversationId, index) => {
    const described = client.describeConversation(conversationId);
    const name = names[index] || described?.name;
    return {
      conversation_id: conversationId,
      ...(name ? { name } : {}),
      ...(described?.chat_mode ? { chat_mode: described.chat_mode } : {}),
      ...(described?.peer_user_id ? { peer_user_id: described.peer_user_id } : {}),
    };
  });
}

function matchesKinds(
  conversation: WeComConversation,
  kinds: readonly WeComChatMode[],
): boolean {
  return !conversation.chat_mode || kinds.includes(conversation.chat_mode);
}

function mergeConversations(
  known: readonly WeComConversation[],
  extra: readonly WeComConversation[],
): WeComConversation[] {
  const byId = new Map<string, WeComConversation>();
  for (const conversation of [...known, ...extra]) {
    const conversationId = conversation.conversation_id.trim();
    if (!conversationId) {
      continue;
    }
    const prev = byId.get(conversationId);
    const name = conversation.name?.replace(/\s+/g, " ").trim() || prev?.name;
    byId.set(conversationId, {
      conversation_id: conversationId,
      ...(name ? { name } : {}),
      chat_mode: conversation.chat_mode ?? prev?.chat_mode,
      ...(conversation.peer_user_id || prev?.peer_user_id
        ? { peer_user_id: conversation.peer_user_id ?? prev?.peer_user_id }
        : {}),
    });
  }
  return [...byId.values()];
}
