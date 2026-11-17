const crypto = require("node:crypto");

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function issueEmailToken(db, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  await db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
  await db.prepare(`
    INSERT INTO email_verification_tokens (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(digest(token), userId, expiresAt, now.toISOString());
  return token;
}

async function issuePhoneCode(db, userId) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const salt = crypto.randomBytes(16);
  const codeHash = crypto.scryptSync(code, salt, 64).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  await db.prepare(`
    INSERT INTO phone_verification_codes (user_id, code_salt, code_hash, expires_at, attempts, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT(user_id) DO UPDATE SET code_salt = excluded.code_salt,
      code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at
  `).run(userId, salt.toString("hex"), codeHash, expiresAt, now.toISOString());
  return code;
}

async function verifyPhoneCode(db, userId, code) {
  return db.transaction(async () => {
    const lockClause = db.isPostgres ? " FOR UPDATE" : "";
    const challenge = await db.prepare(`SELECT * FROM phone_verification_codes WHERE user_id = ?${lockClause}`).get(userId);
    if (!challenge || challenge.expires_at <= new Date().toISOString() || challenge.attempts >= 5) return false;
    await db.prepare("UPDATE phone_verification_codes SET attempts = attempts + 1 WHERE user_id = ?").run(userId);
    const candidate = crypto.scryptSync(code, Buffer.from(challenge.code_salt, "hex"), 64);
    const expected = Buffer.from(challenge.code_hash, "hex");
    return crypto.timingSafeEqual(candidate, expected);
  })();
}

module.exports = { digest, issueEmailToken, issuePhoneCode, verifyPhoneCode };
