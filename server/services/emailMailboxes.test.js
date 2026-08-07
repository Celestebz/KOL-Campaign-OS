const test = require("node:test");
const assert = require("node:assert/strict");
const { dbOperations } = require("../database");
const emailMailboxes = require("./emailMailboxes");

function withPatchedDb(patch, fn) {
  const originals = {};
  for (const key of Object.keys(patch)) {
    originals[key] = dbOperations[key];
    dbOperations[key] = patch[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(originals)) dbOperations[key] = originals[key];
  });
}

test("getDefaultMailbox prefers the is_default row and falls back to the earliest row", async () => {
  await withPatchedDb({
    get: async (sql) => {
      if (sql.includes("WHERE is_default = 1")) return { id: 2, username: "b@x.com", is_default: 1 };
      return null;
    }
  }, async () => {
    const row = await emailMailboxes.getDefaultMailbox();
    assert.equal(row.id, 2);
  });

  await withPatchedDb({
    get: async (sql) => {
      if (sql.includes("WHERE is_default = 1")) return null;
      if (sql.includes("FROM email_settings ORDER BY id LIMIT 1")) return { id: 1, username: "a@x.com" };
      return null;
    }
  }, async () => {
    const row = await emailMailboxes.getDefaultMailbox();
    assert.equal(row.id, 1);
  });
});

test("listMailboxes returns rows sorted by is_default DESC, id", async () => {
  await withPatchedDb({
    query: async (sql) => {
      if (String(sql).includes("FROM email_settings")) {
        const all = [
          { id: 2, label: "default", is_default: 1, enabled: 1 },
          { id: 1, label: "extra", is_default: 0, enabled: 1 },
          { id: 3, label: "disabled", is_default: 0, enabled: 0 }
        ];
        return String(sql).includes("enabled = 1") ? all.filter(r => r.enabled) : all;
      }
      return [];
    }
  }, async () => {
    const rows = await emailMailboxes.listMailboxes();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].label, "default");

    const enabled = await emailMailboxes.listMailboxes({ enabledOnly: true });
    assert.equal(enabled.length, 2);
  });
});

test("resolveMailboxForDraft inherits the source reply mailbox", async () => {
  await withPatchedDb({
    get: async (sql, params = []) => {
      if (sql.includes("FROM email_replies WHERE id = ?")) return { mailbox_id: 9 };
      if (sql.includes("FROM email_settings WHERE id = ?")) return { id: 9, enabled: 1, username: "b@x.com" };
      return null;
    }
  }, async () => {
    const row = await emailMailboxes.resolveMailboxForDraft({ campaignId: 5, sourceReplyId: 33 });
    assert.equal(row.id, 9);
  });
});

test("resolveMailboxForDraft falls back to campaign binding when the reply mailbox is disabled", async () => {
  await withPatchedDb({
    get: async (sql, params = []) => {
      if (sql.includes("FROM email_replies WHERE id = ?")) return { mailbox_id: 9 };
      if (sql.includes("FROM email_settings WHERE id = ?")) {
        return params[0] === 9 ? { id: 9, enabled: 0 } : { id: 3, enabled: 1, username: "c@x.com" };
      }
      if (sql.includes("FROM campaigns WHERE id = ?")) return { mailbox_id: 3 };
      return null;
    }
  }, async () => {
    const row = await emailMailboxes.resolveMailboxForDraft({ campaignId: 5, sourceReplyId: 33 });
    assert.equal(row.id, 3);
  });
});

test("resolveMailboxForDraft falls back to the default mailbox", async () => {
  await withPatchedDb({
    get: async (sql) => {
      if (sql.includes("FROM campaigns WHERE id = ?")) return { mailbox_id: null };
      if (sql.includes("WHERE is_default = 1")) return { id: 1, enabled: 1, username: "a@x.com" };
      return null;
    }
  }, async () => {
    const row = await emailMailboxes.resolveMailboxForDraft({ campaignId: 5 });
    assert.equal(row.id, 1);
  });
});
