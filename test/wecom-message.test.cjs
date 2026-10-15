const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const {
  acceptWeComFrame,
  clearWeComInboxForTests,
  messageCursor,
  parseWeComCallback,
  setWeComInboxRootForTests,
} = require("../dist/index.js");
const {
  listWeComConversations,
  listWeComMessages,
} = require("../dist/wecom-inbox.js");

describe("parseWeComCallback", () => {
  it("reads a group text callback and converts create_time seconds", () => {
    const message = parseWeComCallback({
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-1" },
      body: {
        msgid: "msg-1",
        aibotid: "bot-1",
        chatid: "wr-group",
        chattype: "group",
        from: { userid: "user-1" },
        msgtype: "text",
        text: { content: " 你好 " },
        create_time: 1_700_000_000,
        conversation_title: "工程群",
        sender_name: "小微",
      },
    });
    assert.equal(message.conversation_id, "wr-group");
    assert.equal(message.chat_mode, "group");
    assert.equal(message.text, "你好");
    assert.equal(message.sender_id, "user-1");
    assert.equal(message.sender_label, "小微");
    assert.equal(message.peer_user_id, undefined);
    assert.equal(message.create_at, 1_700_000_000_000);
    assert.equal(
      messageCursor(message),
      `${String(1_700_000_000_000).padStart(16, "0")}:msg-1`,
    );
  });

  it("uses the sender userid as the direct conversation id", () => {
    const message = parseWeComCallback({
      cmd: "aibot_msg_callback",
      body: {
        msgid: "msg-2",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "user-2" },
        msgtype: "voice",
        voice: { content: "语音转写" },
        create_time: "1700000001",
      },
    });
    assert.equal(message.chat_mode, "p2p");
    assert.equal(message.conversation_id, "user-2");
    assert.equal(message.peer_user_id, "user-2");
    assert.equal(message.text, "语音转写");
  });

  it("keeps text parts of a mixed message and drops media-only callbacks", () => {
    const mixed = parseWeComCallback({
      cmd: "aibot_msg_callback",
      body: {
        msgid: "msg-3",
        chattype: "group",
        chatid: "wr-group",
        from: { userid: "user-1" },
        msgtype: "mixed",
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "第一行" } },
            { msgtype: "image", image: { url: "https://example.invalid/a.png" } },
            { msgtype: "text", text: { content: "第二行" } },
          ],
        },
      },
    }, 50);
    assert.equal(mixed.text, "第一行\n第二行");
    assert.equal(mixed.create_at, 50);
    assert.equal(
      parseWeComCallback({
        cmd: "aibot_msg_callback",
        body: {
          msgid: "msg-4",
          chattype: "single",
          from: { userid: "user-1" },
          msgtype: "image",
          image: { url: "https://example.invalid/a.png" },
        },
      }),
      undefined,
    );
    assert.equal(
      parseWeComCallback({
        cmd: "aibot_msg_callback",
        body: {
          msgid: "msg-5",
          aibotid: "bot-1",
          chattype: "group",
          chatid: "wr-group",
          from: { userid: "bot-1" },
          msgtype: "text",
          text: { content: "echo" },
        },
      }),
      undefined,
    );
    assert.equal(
      parseWeComCallback({
        cmd: "aibot_event_callback",
        body: { msgid: "evt-1", msgtype: "event" },
      }),
      undefined,
    );
  });
});

describe("wecom inbox", () => {
  let root;

  afterEach(() => {
    clearWeComInboxForTests();
    setWeComInboxRootForTests(undefined);
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dedupes by message id and lists conversations newest first", () => {
    root = mkdtempSync(join(tmpdir(), "wecom-inbox-"));
    setWeComInboxRootForTests(root);
    const first = {
      cmd: "aibot_msg_callback",
      body: {
        msgid: "m1",
        chattype: "group",
        chatid: "wr-a",
        conversation_title: "甲",
        from: { userid: "u1" },
        msgtype: "text",
        text: { content: "一" },
        create_time: 20,
      },
    };
    assert.equal(acceptWeComFrame("bot-1", first), true);
    assert.equal(acceptWeComFrame("bot-1", first), true);
    acceptWeComFrame("bot-1", {
      cmd: "aibot_msg_callback",
      body: {
        ...first.body,
        msgid: "m2",
        chatid: "wr-b",
        conversation_title: "乙",
        create_time: 30,
      },
    });
    assert.deepEqual(
      listWeComConversations("bot-1").map((chat) => chat.conversation_id),
      ["wr-b", "wr-a"],
    );
    assert.equal(listWeComMessages("bot-1", "wr-a", undefined, 10).length, 1);
    const cursor = messageCursor({ create_at: 20_000, msg_id: "m1" });
    assert.equal(listWeComMessages("bot-1", "wr-a", cursor, 10).length, 0);
  });
});
