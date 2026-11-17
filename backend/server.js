const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { createDatabase } = require("./db");

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 12;
const DUMMY_SALT = Buffer.from("zimconnect-login-salt");
const DUMMY_HASH = crypto.scryptSync("not-a-real-password", DUMMY_SALT, 64);
const projectRoot = path.join(__dirname, "..");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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
    createdAt: row.created_at
  };
}

function createApp(db) {
  const app = express();
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: "Too many authentication attempts. Try again later." })
  });
  app.disable("x-powered-by");
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

    const phone = optionalString(req.body.phone, "Phone", 32);
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

    let session;
    try {
      session = db.transaction(() => {
        db.prepare(`
          INSERT INTO users (id, full_name, email, password_hash, phone, location, created_at, updated_at)
          VALUES (@id, @fullName, @email, @passwordHash, @phone, @location, @now, @now)
        `).run(user);
        return createSession(db, user.id);
      })();
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new HttpError(409, "An account with that email already exists.");
      }
      throw error;
    }

    res.status(201).json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)), ...session });
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

    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
    res.json({ user: publicUser(user), ...createSession(db, user.id) });
  });

  app.post("/api/auth/logout", requireAuth(db), (req, res) => {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(req.auth.tokenHash);
    res.status(204).end();
  });

  app.get("/api/auth/me", requireAuth(db), (req, res) => {
    res.json({ user: publicUser(req.auth.user) });
  });

  app.patch("/api/profile", requireAuth(db), (req, res) => {
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
      values.phone = optionalString(req.body.phone, "Phone", 32);
    }
    if (Object.hasOwn(req.body, "location")) {
      fields.push("location = @location");
      values.location = optionalString(req.body.location, "Location", 100);
    }

    values.id = req.auth.user.id;
    values.updatedAt = new Date().toISOString();
    db.prepare(`UPDATE users SET ${fields.join(", ")}, updated_at = @updatedAt WHERE id = @id`).run(values);
    res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(values.id)) });
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
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "The requested value is already in use." });
    }
    console.error(error);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  });

  return app;
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

    req.auth = { tokenHash, user: row };
    next();
  };
}

if (require.main === module) {
  const db = createDatabase(process.env.DATABASE_PATH);
  const app = createApp(db);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const server = app.listen(port, host, () => {
    console.log(`ZimConnect backend listening on http://${host}:${port}`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createApp };
