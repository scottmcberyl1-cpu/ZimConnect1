const assert = require("node:assert/strict");
const test = require("node:test");
const { createDatabase } = require("./db");
const { issuePhoneCode, verifyPhoneCode } = require("./verification");

test("concurrent phone-code guesses cannot exceed the attempt limit", async () => {
  const db = await createDatabase(":memory:");
  const userId = "phone-verification-test-user";
  const now = new Date().toISOString();
  try {
    await db.prepare(`
      INSERT INTO users (id, full_name, email, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, "Test User", "phone-verification-test@example.com", "test-hash", now, now);
    const validCode = await issuePhoneCode(db, userId);
    const wrongCode = validCode === "000000" ? "000001" : "000000";

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => verifyPhoneCode(db, userId, wrongCode))
    );

    assert.ok(attempts.every((result) => result === false));
    assert.equal(
      (await db.prepare("SELECT attempts FROM phone_verification_codes WHERE user_id = ?").get(userId)).attempts,
      5
    );
    assert.equal(await verifyPhoneCode(db, userId, validCode), false);
  } finally {
    await db.close();
  }
});
