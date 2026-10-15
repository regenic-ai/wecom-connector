import { definePlugin } from "@regenic/plugin-host";
import type { WeComImClient } from "./wecom-client";
import { WeComChatEgress } from "./wecom-chat-egress";
import type { WeComChatMode, WeComConversation } from "./wecom-message";
import { createWeComStreams, wecomStreamKey } from "./wecom-streams";

export interface WeComChatPluginConfig {
  installation_id: string;
  org_id: string;
  conversation_id?: string;
  conversation_name?: string;
  chat_mode?: WeComChatMode;
  peer_user_id?: string;
  conversations?: WeComConversation[];
  client: WeComImClient;
  page_size?: number;
  now?: () => string;
}

export const wecomChatPlugin = definePlugin<WeComChatPluginConfig>({
  name: "wecom-chat",
  inject: ["connectors", "egress"],
  apply(ctx, config) {
    const conversations = pluginConversations(config);
    const streams = createWeComStreams(
      {
        id: config.installation_id,
        org_id: config.org_id,
      },
      conversations,
      config.client,
      config.page_size,
      config.now,
    );
    ctx.effect(() => {
      const disposers = streams.flatMap((stream) => {
        const conversationId = stream.thread_id?.slice("wecom:".length) ?? "";
        const conversation = conversations.find(
          (item) => item.conversation_id === conversationId,
        );
        const connector = ctx.get("connectors").register(
          config.installation_id,
          stream.connector,
          {
            stream_key: stream.stream_key,
            thread_id: stream.thread_id,
            label: stream.label,
            pace: stream.pace,
          },
        );
        const egress = ctx.get("egress").register(
          config.installation_id,
          new WeComChatEgress(config.client, {
            installation_id: config.installation_id,
            conversation_id: conversationId,
            chat_mode: conversation?.chat_mode,
          }),
          wecomStreamKey(conversationId),
        );
        return [connector, egress];
      });
      return () => {
        for (const dispose of disposers.reverse()) {
          dispose();
        }
      };
    });
  },
});

function pluginConversations(config: WeComChatPluginConfig): WeComConversation[] {
  if (config.conversations && config.conversations.length > 0) {
    return config.conversations;
  }
  if (config.conversation_id) {
    return [
      {
        conversation_id: config.conversation_id,
        ...(config.conversation_name ? { name: config.conversation_name } : {}),
        ...(config.chat_mode ? { chat_mode: config.chat_mode } : {}),
        ...(config.peer_user_id ? { peer_user_id: config.peer_user_id } : {}),
      },
    ];
  }
  throw new Error("WeCom plugin requires conversation_id or conversations");
}
