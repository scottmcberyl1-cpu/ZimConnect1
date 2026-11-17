const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

function createDatabase(databasePath = path.join(__dirname, "data", "zimconnect.sqlite")) {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      phone TEXT,
      location TEXT,
      role TEXT NOT NULL DEFAULT 'consumer'
        CHECK (role IN ('consumer', 'business', 'supplier', 'delivery_agent', 'admin')),
      email_verified_at TEXT,
      phone_verified_at TEXT,
      identity_status TEXT NOT NULL DEFAULT 'unverified'
        CHECK (identity_status IN ('unverified', 'pending', 'verified', 'rejected')),
      email_notifications_enabled INTEGER NOT NULL DEFAULT 0,
      sms_notifications_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS phone_verification_codes (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code_salt TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'in_app')),
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'read')),
      created_at TEXT NOT NULL,
      read_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sandbox_pending', 'sandbox_paid', 'sandbox_failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS identity_documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_type TEXT NOT NULL CHECK (document_type IN ('id_front', 'id_back', 'selfie')),
      object_key TEXT NOT NULL UNIQUE,
      content_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('upload_pending', 'pending_review', 'approved', 'rejected')),
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by TEXT REFERENCES users(id),
      delete_after TEXT
    );

    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      object_key TEXT NOT NULL UNIQUE,
      content_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('upload_pending', 'pending_review', 'approved', 'rejected')),
      created_at TEXT NOT NULL,
      delete_after TEXT
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES users(id),
      agent_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK (status IN ('assigned', 'picked_up', 'in_transit', 'delivered', 'cancelled')),
      pickup_lat REAL,
      pickup_lng REAL,
      destination_lat REAL,
      destination_lng REAL,
      current_lat REAL,
      current_lng REAL,
      location_recorded_at TEXT,
      purge_location_at TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY,
      actor_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS identity_documents_review_idx ON identity_documents(status, created_at);
    CREATE INDEX IF NOT EXISTS videos_review_idx ON videos(status, created_at);
    CREATE INDEX IF NOT EXISTS deliveries_agent_idx ON deliveries(agent_id, status);
    CREATE INDEX IF NOT EXISTS deliveries_customer_idx ON deliveries(customer_id, status);
    CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id, created_at DESC);
  `);

  const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
  if (!userColumns.has("email_verified_at")) db.exec("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
  if (!userColumns.has("phone_verified_at")) db.exec("ALTER TABLE users ADD COLUMN phone_verified_at TEXT");
  if (!userColumns.has("identity_status")) {
    db.exec("ALTER TABLE users ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'unverified'");
  }
  if (!userColumns.has("email_notifications_enabled")) {
    db.exec("ALTER TABLE users ADD COLUMN email_notifications_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!userColumns.has("sms_notifications_enabled")) {
    db.exec("ALTER TABLE users ADD COLUMN sms_notifications_enabled INTEGER NOT NULL DEFAULT 0");
  }
  const notificationColumns = new Set(db.prepare("PRAGMA table_info(notifications)").all().map((column) => column.name));
  if (!notificationColumns.has("attempts")) db.exec("ALTER TABLE notifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  if (!notificationColumns.has("next_attempt_at")) db.exec("ALTER TABLE notifications ADD COLUMN next_attempt_at TEXT");
  if (!notificationColumns.has("last_error")) db.exec("ALTER TABLE notifications ADD COLUMN last_error TEXT");

  return db;
}

module.exports = { createDatabase };
