#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  listWeComConversations,
  listWeComMessages,
  summarizeWeComInbox,
} from "./wecom-inbox";

interface LocalConfig {
  bot_id?: string;
}

type Output = (message: string) => void;

export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  stdout: Output = console.log,
  stderr: Output = console.error,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    stdout(usage());
    return 0;
  }

  if (command === "setup") {
    let botId: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] !== "--bot-id" || botId || !rest[index + 1]) {
        stderr("Usage: wecom-connector setup --bot-id <id>");
        return 2;
      }
      botId = rest[index + 1].trim();
      index += 1;
    }
    botId ||= env.WECOM_BOT_ID?.trim() || undefined;
    if (!botId) {
      stderr("Setup requires --bot-id <id> or WECOM_BOT_ID.");
      return 2;
    }
    writeConfig(configPath(env), { bot_id: botId });
    stdout(`Saved Bot ID to ${configPath(env)}.`);
    stdout(
      "Bot Secret is not saved. Configure it in Regenic's installation settings or provide WECOM_BOT_SECRET to the Regenic host.",
    );
    return 0;
  }

  const config = readConfig(configPath(env));
  const botId = env.WECOM_BOT_ID?.trim() || config.bot_id;
  if (command === "doctor") {
    return doctor(botId, env, stdout, stderr);
  }
  if (command === "conversations") {
    if (!requireBotId(botId, stderr)) {
      return 2;
    }
    return showConversations(botId, stdout);
  }
  if (command === "messages") {
    if (!requireBotId(botId, stderr)) {
      return 2;
    }
    const conversationId = rest[0]?.trim();
    if (!conversationId || rest.length !== 1) {
      stderr("Usage: wecom-connector messages <conversation-id>");
      return 2;
    }
    return showMessages(botId, conversationId, stdout);
  }

  stderr(`Unknown command. Run \`wecom-connector help\` for usage.`);
  return 2;
}

function doctor(
  botId: string | undefined,
  env: NodeJS.ProcessEnv,
  stdout: Output,
  stderr: Output,
): number {
  stdout("WeCom local diagnostics");
  stdout(`Bot ID: ${botId ? "configured" : "missing"}`);
  stdout(
    `Bot Secret: ${env.WECOM_BOT_SECRET?.trim() ? "available to this CLI process (not verified by Regenic)" : "not in this CLI environment (Regenic may manage it in the OS keychain)"}`,
  );
  if (!botId) {
    stderr("Run `wecom-connector setup --bot-id <id>` or set WECOM_BOT_ID.");
    stdout("Local inbox: skipped (Bot ID is not configured).");
  } else {
    const inbox = summarizeWeComInbox(botId);
    stdout(
      `Local inbox: ${inbox.exists ? "present" : "not created"}; ` +
        `${inbox.conversation_count} received conversations, ${inbox.message_count} cached messages.`,
    );
  }
  stdout("Live connection: not visible to this standalone CLI; inspect the Regenic host.");
  stdout("This command does not start a WeCom connection or verify credentials.");
  return botId ? 0 : 1;
}

function showConversations(botId: string, stdout: Output): number {
  const conversations = listWeComConversations(botId);
  if (conversations.length === 0) {
    stdout("No received conversations are cached locally.");
    stdout("Only conversations that have delivered messages to this bot can appear here.");
    return 0;
  }
  for (const conversation of conversations) {
    const type =
      conversation.chat_mode === "group"
        ? "group"
        : conversation.chat_mode === "p2p"
          ? "direct"
          : "unknown";
    stdout(`${conversation.conversation_id}\t${type}\t${conversation.name ?? ""}`);
  }
  return 0;
}

function showMessages(botId: string, conversationId: string, stdout: Output): number {
  const messages = listWeComMessages(botId, conversationId, undefined, 200).slice(-50);
  if (messages.length === 0) {
    stdout("No received messages are cached for this conversation.");
    return 0;
  }
  for (const message of messages) {
    stdout(
      `${new Date(message.create_at).toISOString()}\t` +
        `${message.sender_label ?? message.sender_id}\t${message.text}`,
    );
  }
  return 0;
}

function readConfig(path: string): LocalConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid WeCom CLI config at ${path}: expected an object`);
    }
    const botId = "bot_id" in parsed ? parsed.bot_id : undefined;
    if (botId !== undefined && typeof botId !== "string") {
      throw new Error(`Invalid WeCom CLI config at ${path}: bot_id must be a string`);
    }
    return typeof botId === "string" && botId.trim() ? { bot_id: botId.trim() } : {};
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    return {};
  }
}

function writeConfig(path: string, config: LocalConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function configPath(env: NodeJS.ProcessEnv): string {
  const override = env.REGENIC_WECOM_CONFIG?.trim();
  if (override) {
    return override;
  }
  const home = env.REGENIC_HOME?.trim() || join(homedir(), ".regenic");
  return join(home, "wecom-cli.json");
}

function requireBotId(botId: string | undefined, stderr: Output): botId is string {
  if (botId) {
    return true;
  }
  stderr("Bot ID is not configured. Run `wecom-connector setup --bot-id <id>`.");
  return false;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function usage(): string {
  return [
    "Usage: wecom-connector <command>",
    "",
    "Commands:",
    "  setup --bot-id <id>  Save local Bot ID (never stores the Bot Secret)",
    "  doctor               Check local config and inbox without connecting",
    "  conversations        List locally received conversations",
    "  messages <chat-id>   Show up to 50 locally cached messages",
    "  help                 Show this help",
    "",
    "Set WECOM_BOT_SECRET in the Regenic host environment or use its OS keychain.",
  ].join("\n");
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : "WeCom CLI failed");
      process.exitCode = 1;
    },
  );
}
