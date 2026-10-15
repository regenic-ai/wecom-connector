import type {
  ContentPart,
  DeliveryReceipt,
  EgressAdapter,
  EgressCapabilities,
  SendIntent,
} from "@regenic/connector-contract";
import type { WeComImClient } from "./wecom-client";
import { WeComApiError } from "./wecom-client";
import { WECOM_SOURCE, type WeComChatMode } from "./wecom-message";

export interface WeComChatEgressOptions {
  installation_id: string;
  conversation_id: string;
  chat_mode?: WeComChatMode;
}

export class WeComChatEgress implements EgressAdapter {
  readonly source = WECOM_SOURCE;

  constructor(
    private readonly client: WeComImClient,
    private readonly options: WeComChatEgressOptions,
  ) {}

  capabilities(): EgressCapabilities {
    return { reply: true, edit: false, tombstone: false };
  }

  async send(intent: SendIntent): Promise<DeliveryReceipt> {
    if (intent.installation_id !== this.options.installation_id) {
      throw new WeComApiError("Send intent installation does not match the WeCom adapter");
    }
    const text = textFromContentParts(intent.content);
    if (!text) {
      throw new WeComApiError("WeCom send needs a text body");
    }
    const described = this.client.describeConversation(this.options.conversation_id);
    const sent = await this.client.sendText({
      conversation_id: this.options.conversation_id,
      chat_mode: this.options.chat_mode ?? described?.chat_mode,
      text,
    });
    return {
      accepted: true,
      rpc_id: sent.message_id,
      channel_message_ids: [sent.message_id],
    };
  }
}

export function textFromContentParts(content: ContentPart[]): string {
  const texts: string[] = [];
  for (const part of content) {
    if (part.role === "attachment") {
      throw new WeComApiError("WeCom send cannot deliver attachments");
    }
    if (part.role === "body" && typeof part.text === "string" && part.text.trim()) {
      texts.push(part.text.trim());
    }
  }
  return texts.join("\n").trim();
}
