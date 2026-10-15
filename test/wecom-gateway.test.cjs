const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const {
  WECOM_WS_URL,
  WeComApiError,
  WeComAppClient,
  clearWeComInboxForTests,
  setWeComInboxRootForTests,
} = require("../dist/index.js");

describe("WeCom long connection", () => {
  let root;

  afterEach(() => {
    clearWeComInboxForTests();
    setWeComInboxRootForTests(undefined);
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("subscribes, stores an inbound callback, and sends markdown", async () => {
    root = mkdtempSync(join(tmpdir(), "wecom-gateway-"));
    setWeComInboxRootForTests(root);
    const sent = [];
    const socket = scriptedSocket(sent, (frame) => ({
      headers: { req_id: frame.headers.req_id },
      errcode: 0,
      errmsg: "ok",
    }));
    const client = new WeComAppClient(
      { bot_id: "bot-1", secret: "secret-value" },
      {
        open: socket.open,
        heartbeat_ms: 0,
        reconnect: false,
        now: () => 80,
      },
    );
    await client.ensureConnected();
    assert.equal(socket.urls[0], WECOM_WS_URL);
    assert.equal(sent[0].cmd, "aibot_subscribe");
    assert.equal(sent[0].body.bot_id, "bot-1");
    assert.equal(sent[0].body.secret, "secret-value");

    socket.push({
      cmd: "aibot_msg_callback",
      headers: { req_id: "inbound-1" },
      body: {
        msgid: "msg-1",
        aibotid: "bot-1",
        chatid: "wr-group",
        chattype: "group",
        from: { userid: "user-1" },
        msgtype: "text",
        text: { content: "在吗" },
        conversation_title: "工程群",
      },
    });

    const messages = await client.listMessages({
      conversation_id: "wr-group",
      limit: 10,
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "在吗");
    assert.equal(messages[0].create_at, 80);
    assert.deepEqual(await client.listRecentConversations(["group"]), [
      {
        conversation_id: "wr-group",
        name: "工程群",
        chat_mode: "group",
      },
    ]);

    const sentMessage = await client.sendText({
      conversation_id: "wr-group",
      chat_mode: "group",
      text: "收到",
    });
    const reply = sent.find((frame) => frame.cmd === "aibot_send_msg");
    assert.equal(sentMessage.message_id, reply.headers.req_id);
    assert.equal(reply.body.chatid, "wr-group");
    assert.equal(reply.body.chat_type, 2);
    assert.equal(reply.body.msgtype, "markdown");
    assert.deepEqual(reply.body.markdown, { content: "收到" });
    client.disconnect();
  });

  it("scrubs the secret from a rejected subscribe", async () => {
    const socket = scriptedSocket([], (frame) => ({
      headers: { req_id: frame.headers.req_id },
      errcode: 400,
      errmsg: "bad secret-value",
    }));
    const client = new WeComAppClient(
      { bot_id: "bot-1", secret: "secret-value" },
      { open: socket.open, heartbeat_ms: 0, reconnect: false },
    );
    await assert.rejects(
      () => client.ensureConnected(),
      (error) => {
        assert.equal(error instanceof WeComApiError, true);
        assert.equal(error.code, 400);
        assert.match(error.message, /failed \(400\)/);
        assert.equal(error.message.includes("secret-value"), false);
        assert.match(error.message, /\[secret\]/);
        return true;
      },
    );
    client.disconnect();
  });
});

function scriptedSocket(sent, respond) {
  let push = () => {};
  let onClose = () => {};
  const urls = [];
  return {
    urls,
    sent,
    push(frame) {
      push(JSON.stringify(frame));
    },
    open: async (url) => {
      urls.push(url);
      return {
        socket: {
          send(data) {
            const frame = JSON.parse(data);
            sent.push(frame);
            queueMicrotask(() => {
              push(JSON.stringify(respond(frame)));
            });
          },
          close() {
            onClose();
          },
        },
        onMessage(handler) {
          push = handler;
        },
        onClose(handler) {
          onClose = handler;
        },
      };
    },
  };
}
