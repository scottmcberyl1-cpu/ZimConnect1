const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const helmet = require("helmet");
const { createDatabase } = require("./db");
const { validateConfiguration } = require("./config");
const { HttpError } = require("./errors");
const providers = require("./providers");
const { digest, issueEmailToken, issuePhoneCode, verifyPhoneCode } = require("./verification");
const { registerIntegrationRoutes } = require("./integrations");
const { createEncryptedBackup } = require("./backup");
const { purgeExpiredData } = require("./retention");
const { dispatchQueuedNotifications } = require("./notifications");

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 12;
const DUMMY_SALT = Buffer.from("zimconnect-login-salt");
const DUMMY_HASH = crypto.scryptSync("not-a-real-password", DUMMY_SALT, 64);
const projectRoot = path.join(__dirname, "..");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function optionalString(value, name, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new HttpError(400, `${name} must be a string of at most ${maxLength} characters.`);
  }
  return value.trim() || null;
}

function normalizeEmail(value) {
  const email = requiredString(value, "Email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  return email;
}

function normalizePhone(value) {
  const phone = requiredString(value, "Phone", 32).replace(/[ ()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new HttpError(400, "Phone must use international format, for example +263771234567.");
  }
  return phone;
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`${salt.toString("hex")}:${derivedKey.toString("hex")}`);
    });
  });
}

function verifyPassword(password, storedHash) {
  const [saltHex, hashHex] = storedHash.split(":");
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(derivedKey.length === expected.length && crypto.timingSafeEqual(derivedKey, expected));
    });
  });
}

function digestToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function publicUser(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    location: row.location,
    role: row.role,
    identityStatus: row.identity_status,
    emailVerified: Boolean(row.email_verified_at),
    phoneVerified: Boolean(row.phone_verified_at),
    createdAt: row.created_at
  };
}

function createApp(db, options = {}) {
  const app = express();
  const services = options.providers || providers;
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: "Too many authentication attempts. Try again later." })
  });
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
  app.set("trust proxy", Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 0);
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer"
    });
    next();
  });
  app.use(express.json({ limit: "16kb" }));

  app.get("/api/health", (req, res) => {
    db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  });

  app.post("/api/auth/register", authLimiter, async (req, res) => {
    if (!isObject(req.body)) throw new HttpError(400, "Request body must be a JSON object.");
    const fullName = requiredString(req.body.fullName, "Full name", 100);
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;
    if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
      throw new HttpError(400, `Password must be between ${PASSWORD_MIN_LENGTH} and 128 characters.`);
    }

    const phone = normalizePhone(req.body.phone);
    const location = optionalString(req.body.location, "Location", 100);
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      fullName,
      email,
      passwordHash: await hashPassword(password),
      phone,
      location,
      now
    };

    let challenges;
    try {
      challenges = db.transaction(() => {
        db.prepare(`
          INSERT INTO users (id, full_name, email, password_hash, phone, location, created_at, updated_at)
          VALUES (@id, @fullName, @email, @passwordHash, @phone, @location, @now, @now)
        `).run(user);
        return {
          emailToken: issueEmailToken(db, user.id),
          phoneCode: issuePhoneCode(db, user.id)
        };
      })();
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new HttpError(409, "An account with that email already exists.");
      }
      throw error;
    }

    const createdUser = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    try {
      await sendVerificationMessages(services, createdUser, challenges);
    } catch (error) {
      throw new HttpError(503, "Account created, but verification delivery failed. Retry using /api/auth/resend-verification.");
    }
    res.status(202).json({ user: publicUser(createdUser), verificationRequired: ["email", "phone"] });
  });

  app.post("/api/auth/login", authLimiter, async (req, res) => {
    if (!isObject(req.body)) throw new HttpError(400, "Request body must be a JSON object.");
    const email = normalizeEmail(req.body.email);
    if (typeof req.body.password !== "string" || req.body.password.length > 128) {
      throw new HttpError(400, "Email or password is incorrect.");
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    const matches = await verifyPassword(
      req.body.password,
      user ? user.password_hash : `${DUMMY_SALT.toString("hex")}:${DUMMY_HASH.toString("hex")}`
    );
    if (!user || !matches) throw new HttpError(401, "Email or password is incorrect.");
    if (!user.email_verified_at || !user.phone_verified_at) {
      throw new HttpError(403, "Verify both email and phone before signing in.");
    }

    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
    res.json({ user: publicUser(user), ...createSession(db, user.id) });
  });

  app.post("/api/auth/resend-verification", authLimiter, async (req, res) => {
    if (!isObject(req.body)) throw new HttpError(400, "Request body must be a JSON object.");
    const email = normalizeEmail(req.body.email);
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (user && (!user.email_verified_at || !user.phone_verified_at)) {
      const emailToken = user.email_verified_at ? null : issueEmailToken(db, user.id);
      const phoneCode = user.phone_verified_at ? null : issuePhoneCode(db, user.id);
      try {
        await sendVerificationMessages(services, user, { emailToken, phoneCode });
      } catch (error) {
        throw new HttpError(503, "Verification delivery failed. Try again later.");
      }
    }
    res.status(202).json({ message: "If the account needs verification, new instructions have been sent." });
  });

  app.get("/api/auth/verify-email", (req, res) => {
    res.type("html").send(`<!doctype html>
      <html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Verify your email</title><body><main>
      <h1>Verify your ZimConnect email</h1>
      <p>Confirm this action to finish verifying your account.</p>
      <button id="confirm">Confirm email</button><p id="result" role="status"></p>
      <script>
        const token = window.location.hash.slice(1);
        document.getElementById("confirm").addEventListener("click", async () => {
          if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
            document.getElementById("result").textContent = "This verification link is invalid or expired.";
            return;
          }
          const response = await fetch("/api/auth/verify-email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token })
          });
          document.getElementById("result").textContent = response.ok
            ? "Email verified. You can now sign in after verifying your phone."
            : "This verification link is invalid or expired.";
        });
      </script></main></body></html>`);
  });

  app.post("/api/auth/verify-email", authLimiter, (req, res) => {
    if (!isObject(req.body) || typeof req.body.token !== "string" ||
        !/^[A-Za-z0-9_-]{40,100}$/.test(req.body.token)) {
      throw new HttpError(400, "Verification token is invalid.");
    }
    const challenge = db.prepare("SELECT * FROM email_verification_tokens WHERE token_hash = ?")
      .get(digest(req.body.token));
    if (!challenge || challenge.expires_at <= new Date().toISOString()) {
      throw new HttpError(400, "Verification token is invalid or expired.");
    }
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare("UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?").run(now, now, challenge.user_id);
      db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(challenge.user_id);
    })();
    res.json({ emailVerified: true });
  });

  app.post("/api/auth/verify-phone", authLimiter, async (req, res) => {
    if (!isObject(req.body)) throw new HttpError(400, "Request body must be a JSON object.");
    const email = normalizeEmail(req.body.email);
    if (typeof req.body.code !== "string" || !/^\d{6}$/.test(req.body.code)) {
      throw new HttpError(400, "Enter the six-digit verification code.");
    }
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !verifyPhoneCode(db, user.id, req.body.code)) {
      throw new HttpError(400, "Verification code is invalid or expired.");
    }
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare("UPDATE users SET phone_verified_at = ?, updated_at = ? WHERE id = ?").run(now, now, user.id);
      db.prepare("DELETE FROM phone_verification_codes WHERE user_id = ?").run(user.id);
    })();
    if (!user.email_verified_at) {
      return res.json({ phoneVerified: true, emailVerificationRequired: true });
    }
    const updatedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    res.json({ phoneVerified: true, user: publicUser(updatedUser), ...createSession(db, user.id) });
  });

  app.post("/api/auth/logout", requireAuth(db), (req, res) => {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(req.auth.tokenHash);
    res.status(204).end();
  });

  app.get("/api/auth/me", requireAuth(db), (req, res) => {
    res.json({ user: publicUser(req.auth.user) });
  });

  app.patch("/api/profile", requireAuth(db), async (req, res) => {
    if (!isObject(req.body)) throw new HttpError(400, "Request body must be a JSON object.");
    const allowed = new Set(["fullName", "phone", "location"]);
    const keys = Object.keys(req.body);
    if (!keys.length || keys.some((key) => !allowed.has(key))) {
      throw new HttpError(400, "Provide one or more of: fullName, phone, location.");
    }

    const fields = [];
    const values = {};
    if (Object.hasOwn(req.body, "fullName")) {
      fields.push("full_name = @fullName");
      values.fullName = requiredString(req.body.fullName, "Full name", 100);
    }
    if (Object.hasOwn(req.body, "phone")) {
      fields.push("phone = @phone");
      values.phone = normalizePhone(req.body.phone);
      if (values.phone !== req.auth.user.phone) {
        fields.push("phone_verified_at = NULL");
        db.prepare("DELETE FROM phone_verification_codes WHERE user_id = ?").run(req.auth.user.id);
      }
    }
    if (Object.hasOwn(req.body, "location")) {
      fields.push("location = @location");
      values.location = optionalString(req.body.location, "Location", 100);
    }

    values.id = req.auth.user.id;
    values.updatedAt = new Date().toISOString();
    db.prepare(`UPDATE users SET ${fields.join(", ")}, updated_at = @updatedAt WHERE id = @id`).run(values);
    const updatedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(values.id);
    if (values.phone && values.phone !== req.auth.user.phone) {
      const code = issuePhoneCode(db, values.id);
      try {
        await services.sendSms({ to: values.phone, message: `Your ZimConnect verification code is ${code}. It expires in 10 minutes.` });
      } catch (error) {
        throw new HttpError(503, "Phone was updated, but verification SMS delivery failed. Use /api/auth/resend-verification.");
      }
      return res.json({ user: publicUser(updatedUser), phoneVerificationRequired: true });
    }
    res.json({ user: publicUser(updatedUser) });
  });

  app.get("/api/profile/notification-preferences", requireAuth(db), (req, res) => {
    const user = db.prepare(`
      SELECT email_notifications_enabled AS email, sms_notifications_enabled AS sms
      FROM users WHERE id = ?
    `).get(req.auth.user.id);
    res.json({ email: Boolean(user.email), sms: Boolean(user.sms) });
  });

  app.patch("/api/profile/notification-preferences", requireAuth(db), (req, res) => {
    if (!isObject(req.body) || !Object.keys(req.body).length ||
        Object.keys(req.body).some((key) => !["email", "sms"].includes(key)) ||
        Object.values(req.body).some((value) => typeof value !== "boolean")) {
      throw new HttpError(400, "Provide one or more email/sms boolean preferences.");
    }
    const fields = [];
    const values = {};
    if (Object.hasOwn(req.body, "email")) {
      fields.push("email_notifications_enabled = @email");
      values.email = Number(req.body.email);
    }
    if (Object.hasOwn(req.body, "sms")) {
      fields.push("sms_notifications_enabled = @sms");
      values.sms = Number(req.body.sms);
    }
    values.id = req.auth.user.id;
    values.updatedAt = new Date().toISOString();
    db.prepare(`UPDATE users SET ${fields.join(", ")}, updated_at = @updatedAt WHERE id = @id`).run(values);
    res.json({ email: Boolean(values.email ?? req.auth.user.email_notifications_enabled), sms: Boolean(values.sms ?? req.auth.user.sms_notifications_enabled) });
  });

  app.get("/api/admin/users", requireAuth(db), requireRole("admin"), (req, res) => {
    const users = db.prepare(`
      SELECT id, full_name AS fullName, email, phone, location, role, email_verified_at AS emailVerifiedAt,
        phone_verified_at AS phoneVerifiedAt, identity_status AS identityStatus, created_at AS createdAt
      FROM users ORDER BY created_at DESC LIMIT 200
    `).all();
    res.json({ users });
  });

  app.patch("/api/admin/users/:id/role", requireAuth(db), requireRole("admin"), (req, res) => {
    const roles = new Set(["consumer", "business", "supplier", "delivery_agent", "admin"]);
    const role = req.body && req.body.role;
    if (!roles.has(role)) throw new HttpError(400, "Role is invalid.");
    if (req.params.id === req.auth.user.id && role !== "admin") {
      throw new HttpError(400, "Use another administrator to change your own role.");
    }
    const user = db.prepare("SELECT id, role, email_verified_at, phone_verified_at, identity_status FROM users WHERE id = ?").get(req.params.id);
    if (!user) throw new HttpError(404, "User not found.");
    if (!user.email_verified_at || !user.phone_verified_at) throw new HttpError(409, "Verify the user's email and phone before assigning a role.");
    if (["business", "supplier", "delivery_agent"].includes(role) && user.identity_status !== "verified") {
      throw new HttpError(409, "Approve the user's identity documents before assigning this role.");
    }
    const updateRole = db.transaction(() => {
      if (user.role === "admin" && role !== "admin") {
        const admins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
        if (admins < 2) throw new HttpError(409, "The last administrator cannot be demoted.");
      }
      db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(role, new Date().toISOString(), user.id);
      db.prepare(`
        INSERT INTO admin_audit_log (id, actor_id, action, target_type, target_id, details, created_at)
        VALUES (?, ?, 'user.role.change', 'user', ?, ?, ?)
      `).run(crypto.randomUUID(), req.auth.user.id, user.id, JSON.stringify({ from: user.role, to: role }), new Date().toISOString());
    });
    updateRole.immediate();
    res.json({ id: user.id, role });
  });

  registerIntegrationRoutes({
    app,
    db,
    requireAuth: requireAuth(db),
    requireRole,
    providers: services
  });

  app.use("/css", express.static(path.join(projectRoot, "css")));
  app.use("/js", express.static(path.join(projectRoot, "js")));
  app.use("/assets", express.static(path.join(projectRoot, "assets")));
  app.get("/", (req, res) => res.sendFile(path.join(projectRoot, "index.html")));

  app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint not found." }));
  app.use((req, res) => res.status(404).json({ error: "Not found." }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
      return res.status(400).json({ error: "Request body contains invalid JSON." });
    }
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body is too large." });
    }
    if (error.status === 415) {
      return res.status(415).json({ error: "Unsupported request content type or encoding." });
    }
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "The requested value is already in use." });
    }
    console.error(error);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  });

  return app;
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.auth || req.auth.user.role !== role) {
      return res.status(403).json({ error: `This action requires the ${role.replace("_", " ")} role.` });
    }
    next();
  };
}

function sendVerificationMessages(services, user, challenges) {
  const tasks = [];
  if (challenges.emailToken) {
    const baseUrl = process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3000";
    const link = `${baseUrl}/api/auth/verify-email#${challenges.emailToken}`;
    tasks.push(services.sendEmail({
      to: user.email,
      subject: "Verify your ZimConnect email",
      text: `Verify your email within 30 minutes: ${link}`,
      html: `<p>Hello ${escapeHtml(user.full_name)},</p><p><a href="${escapeHtml(link)}">Verify your email</a>. This link expires in 30 minutes.</p>`
    }));
  }
  if (challenges.phoneCode) {
    tasks.push(services.sendSms({
      to: user.phone,
      message: `Your ZimConnect verification code is ${challenges.phoneCode}. It expires in 10 minutes.`
    }));
  }
  return Promise.all(tasks);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(digestToken(token), userId, expiresAt, new Date().toISOString());
  return { token, expiresAt };
}

function requireAuth(db) {
  return (req, res, next) => {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.get("authorization") || "");
    if (!match) return res.status(401).json({ error: "Authentication required." });

    const tokenHash = digestToken(match[1]);
    const row = db.prepare(`
      SELECT sessions.token_hash, sessions.expires_at, users.*
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
    `).get(tokenHash);
    if (!row || row.expires_at <= new Date().toISOString()) {
      if (row) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      return res.status(401).json({ error: "Session is invalid or expired." });
    }

    if (!row.email_verified_at || !row.phone_verified_at) {
      return res.status(403).json({ error: "Verify both email and phone before accessing this account." });
    }
    req.auth = { tokenHash, user: row };
    next();
  };
}

if (require.main === module) {
  try {
    validateConfiguration();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const db = createDatabase(process.env.DATABASE_PATH);
  const app = createApp(db);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const server = app.listen(port, host, () => {
    console.log(`ZimConnect backend listening on http://${host}:${port}`);
  });
  let backupTimer;
  if (process.env.BACKUP_ENCRYPTION_KEY) {
    const createScheduledBackup = () => createEncryptedBackup(
      db,
      process.env.BACKUP_DIRECTORY || path.join(__dirname, "backups"),
      Number(process.env.BACKUP_RETENTION_DAYS || 30)
    ).then((file) => console.log(`Encrypted backup created: ${file}`))
      .catch((error) => console.error("Scheduled encrypted backup failed:", error));
    createScheduledBackup();
    backupTimer = setInterval(() => {
      createScheduledBackup();
    }, 24 * 60 * 60 * 1000);
    backupTimer.unref();
  } else {
    console.warn("Automated backups are disabled; configure BACKUP_ENCRYPTION_KEY.");
  }
  const retentionTimer = setInterval(() => {
    purgeExpiredData(db).catch((error) => console.error("Scheduled data retention cleanup failed:", error));
  }, 60 * 60 * 1000);
  retentionTimer.unref();
  purgeExpiredData(db).catch((error) => console.error("Startup data retention cleanup failed:", error));
  let dispatchingNotifications = false;
  const dispatchNotifications = async () => {
    if (dispatchingNotifications) return;
    dispatchingNotifications = true;
    try {
      await dispatchQueuedNotifications(db, providers);
    } catch (error) {
      console.error("Notification queue processing failed:", error);
    } finally {
      dispatchingNotifications = false;
    }
  };
  dispatchNotifications();
  const notificationTimer = setInterval(dispatchNotifications, 15 * 1000);
  notificationTimer.unref();

  const shutdown = () => {
    if (backupTimer) clearInterval(backupTimer);
    clearInterval(retentionTimer);
    clearInterval(notificationTimer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createApp, requireRole };
