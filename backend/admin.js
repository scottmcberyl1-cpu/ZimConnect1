require("./config");
const { createDatabase } = require("./db");

function promoteVerifiedUser(email) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Provide a valid account email.");
  }
  const db = createDatabase(process.env.DATABASE_PATH);
  try {
    const promote = db.transaction(() => {
      const user = db.prepare("SELECT id, role, email_verified_at, phone_verified_at FROM users WHERE email = ?")
        .get(email.trim().toLowerCase());
      if (!user) throw new Error("Account not found.");
      if (!user.email_verified_at || !user.phone_verified_at) {
        throw new Error("The account must verify its email and phone before promotion.");
      }
      if (user.role === "admin") return false;
      const now = new Date().toISOString();
      db.prepare("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?").run(now, user.id);
      db.prepare(`
        INSERT INTO admin_audit_log (id, actor_id, action, target_type, target_id, details, created_at)
        VALUES (?, NULL, 'bootstrap.admin.promote', 'user', ?, ?, ?)
      `).run(require("node:crypto").randomUUID(), user.id, JSON.stringify({ email: email.trim().toLowerCase() }), now);
      return true;
    });
    return promote();
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const [action, email] = process.argv.slice(2);
  if (action !== "promote" || !email) {
    console.error("Usage: npm run admin:promote -- <verified-account-email>");
    process.exitCode = 1;
  } else {
    try {
      const changed = promoteVerifiedUser(email);
      console.log(changed ? "Verified account promoted to admin." : "Account is already an admin.");
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { promoteVerifiedUser };
