import type { SyncDirectoryPage, SyncSource } from "@regenic/connector-contract";
import type { WeComImClient } from "./wecom-client";
import { WECOM_SOURCE, type WeComChatMode, type WeComConversation } from "./wecom-message";
import { WECOM_RECENT_LIMIT, wecomStreamKey } from "./wecom-streams";

export function createWeComPickedSyncSource(
  conversations: readonly WeComConversation[],
): SyncSource {
  return {
    async listDirectory(): Promise<SyncDirectoryPage> {
      return {
        members: conversations.flatMap((conversation) => memberOf(conversation)),
        complete: true,
        replaces: true,
      };
    },
  };
}

export function createWeComRecentSyncSource(
  client: WeComImClient,
  kinds: readonly WeComChatMode[],
): SyncSource {
  return {
    async listDirectory(): Promise<SyncDirectoryPage> {
      const conversations = await client.listRecentConversations(kinds);
      return {
        members: conversations.slice(0, WECOM_RECENT_LIMIT).flatMap((conversation) =>
          memberOf(conversation),
        ),
        complete: true,
      };
    },
  };
}

export function createWeComSyncSource(
  client: WeComImClient,
  kinds: readonly WeComChatMode[],
): SyncSource {
  return {
    async listDirectory(): Promise<SyncDirectoryPage> {
      const conversations = await client.listRecentConversations(kinds);
      return {
        members: conversations.flatMap((conversation) => memberOf(conversation)),
        complete: true,
        replaces: true,
      };
    },
  };
}

function memberOf(conversation: WeComConversation): SyncDirectoryPage["members"] {
  const conversationId = conversation.conversation_id.trim();
  if (!conversationId) {
    return [];
  }
  const name = conversation.name?.trim();
  return [
    {
      stream_key: wecomStreamKey(conversationId),
      thread_id: `${WECOM_SOURCE}:${conversationId}`,
      ...(name ? { label: name } : {}),
      ...(conversation.chat_mode ? { kind: conversation.chat_mode } : {}),
    },
  ];
}
