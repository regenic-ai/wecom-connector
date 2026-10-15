import type { ConnectorInstallation, ConnectorStream } from "@regenic/connector-contract";
import type { WeComImClient } from "./wecom-client";
import { WeComChatPollConnector } from "./wecom-chat-poll-connector";
import { WECOM_SOURCE, type WeComConversation } from "./wecom-message";

export const WECOM_STREAM_PACE = {
  idle_ms: 15_000,
  catch_up_pages: 5,
} as const;

export const WECOM_RECENT_LIMIT = 30;

export function wecomStreamKey(conversationId: string): string {
  return `chat:${conversationId}`;
}

export function wecomConversationIdFromStreamKey(
  streamKey: string,
): string | undefined {
  if (!streamKey.startsWith("chat:") || streamKey.length <= 5) {
    return undefined;
  }
  return streamKey.slice(5);
}

export function createWeComStreams(
  installation: Pick<ConnectorInstallation, "id" | "org_id">,
  conversations: WeComConversation[],
  client: WeComImClient,
  pageSize?: number,
  now?: () => string,
): ConnectorStream[] {
  return conversations.map((conversation) => ({
    stream_key: wecomStreamKey(conversation.conversation_id),
    thread_id: `${WECOM_SOURCE}:${conversation.conversation_id}`,
    label: conversation.name ?? conversation.conversation_id,
    pace: { ...WECOM_STREAM_PACE },
    connector: new WeComChatPollConnector(client, {
      connector_id: installation.id,
      org_id: installation.org_id,
      conversation_id: conversation.conversation_id,
      conversation_name: conversation.name,
      chat_mode: conversation.chat_mode,
      peer_user_id: conversation.peer_user_id,
      page_size: pageSize,
      now,
    }),
  }));
}
