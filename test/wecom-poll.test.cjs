const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { verifyPollConnectorConformance } = require("@regenic/connector-test-utils");
const { WeComChatPollConnector, messageCursor } = require("../dist/index.js");

describe("WeComChatPollConnector", () => {
  it("pages forward from the cursor and stays stable", async () => {
    const messages = [
      message("m1", 10, "第一句"),
      message("m2", 20, "第二句"),
    ];
    const connector = new WeComChatPollConnector(fakeClient(messages), {
      connector_id: "wecom-1",
      org_id: "local-owner",
      conversation_id: "wr-1",
      conversation_name: "工程群",
      chat_mode: "group",
      now: () => "2026-10-14T00:00:00.000Z",
    });
    const report = await verifyPollConnectorConformance({
      connector,
      cursor: null,
      connector_id: "wecom-1",
      source: "wecom",
    });
    assert.equal(report.record_count, 2);
    const page = await connector.poll(null);
    assert.equal(page.has_more, false);
    assert.equal(page.poll_hint.live_seeded, true);
    assert.equal(page.poll_hint.history_pending, false);
    assert.equal(page.next_cursor, messageCursor(messages[1]));
    assert.equal(page.batch.records[0].external_id, "m1");
    assert.equal(page.batch.records[0].actor.display_name, "小微");
    const next = await connector.poll({ value: page.next_cursor });
    assert.equal(next.batch.records.length, 0);
    assert.equal(next.next_cursor, page.next_cursor);
  });

  it("reports another live page when the buffer is longer than the page", async () => {
    const connector = new WeComChatPollConnector(
      fakeClient([message("m1", 10, "一"), message("m2", 20, "二"), message("m3", 30, "三")]),
      {
        connector_id: "wecom-1",
        org_id: "local-owner",
        conversation_id: "wr-1",
        page_size: 2,
        now: () => "2026-10-14T00:00:00.000Z",
      },
    );
    const page = await connector.poll(null);
    assert.equal(page.batch.records.length, 2);
    assert.equal(page.has_more, true);
    assert.deepEqual(
      page.batch.records.map((record) => record.external_id),
      ["m1", "m2"],
    );
  });

  it("does not invent history for an older page", async () => {
    const connector = new WeComChatPollConnector(fakeClient([message("m1", 10, "一")]), {
      connector_id: "wecom-1",
      org_id: "local-owner",
      conversation_id: "wr-1",
      now: () => "2026-10-14T00:00:00.000Z",
    });
    const page = await connector.poll({ value: "cursor" }, { older: true });
    assert.equal(page.batch.records.length, 0);
    assert.equal(page.has_more, false);
    assert.equal(page.poll_hint.history_pending, false);
    assert.equal(page.next_cursor, "cursor");
  });
});

function message(msgId, createAt, text) {
  return {
    msg_id: msgId,
    conversation_id: "wr-1",
    conversation_title: "工程群",
    chat_mode: "group",
    create_at: createAt,
    sender_id: "user-1",
    sender_label: "小微",
    text,
    msg_type: "text",
  };
}

function fakeClient(messages) {
  return {
    async ensureConnected() {},
    describeConversation() {
      return { conversation_id: "wr-1", name: "工程群", chat_mode: "group" };
    },
    async listRecentConversations() {
      return [{ conversation_id: "wr-1", name: "工程群", chat_mode: "group" }];
    },
    async listMessages({ after, limit }) {
      const filtered = after
        ? messages.filter((item) => messageCursor(item) > after)
        : messages;
      return filtered.slice(0, limit);
    },
    async sendText() {
      return { message_id: "req-1" };
    },
  };
}
