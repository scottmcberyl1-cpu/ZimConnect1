const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const Database = require("better-sqlite3");
const { Pool, types } = require("pg");

types.setTypeParser(20, (value) => Number(value));

const DEFAULT_DATABASE_PATH = path.join(__dirname, "data", "zimconnect.sqlite");
const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
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
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

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
    locked_until TEXT,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS products_active_idx ON products(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    payment_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending_payment', 'paid', 'processing', 'ready_for_pickup', 'in_transit', 'delivered', 'cancelled', 'refunded')),
    total_cents INTEGER NOT NULL CHECK (total_cents > 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    stock_released_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, created_at);

  CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    seller_id TEXT NOT NULL REFERENCES users(id),
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0)
  );
  CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
  CREATE TABLE IF NOT EXISTS order_events (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    actor_id TEXT REFERENCES users(id),
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events(order_id, created_at);

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    order_id TEXT REFERENCES orders(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    currency TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'sandbox',
    provider_reference TEXT UNIQUE,
    poll_url TEXT,
    redirect_url TEXT,
    status TEXT NOT NULL CHECK (status IN ('created', 'pending', 'paid', 'failed', 'cancelled', 'refunded', 'sandbox_pending', 'sandbox_paid', 'sandbox_failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id, created_at DESC);

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
    policy_version TEXT,
    consented_at TEXT,
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
  CREATE INDEX IF NOT EXISTS identity_documents_review_idx ON identity_documents(status, created_at);
  CREATE INDEX IF NOT EXISTS videos_review_idx ON videos(status, created_at);

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
  CREATE INDEX IF NOT EXISTS deliveries_agent_idx ON deliveries(agent_id, status);
  CREATE INDEX IF NOT EXISTS deliveries_customer_idx ON deliveries(customer_id, status);

  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id TEXT PRIMARY KEY,
    actor_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

function normalizeArguments(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  if (args.length === 1 && args[0] && typeof args[0] === "object") return args[0];
  return args;
}

function translatePostgresQuery(sql, args) {
  const values = [];
  let translated = "";
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      translated += character;
      if (character === quote && sql[index + 1] === quote) translated += sql[++index];
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      translated += character;
      continue;
    }
    if (character === "?" && Array.isArray(args)) {
      values.push(args[values.length]);
      translated += `$${values.length}`;
      continue;
    }
    if (character === "@" && !Array.isArray(args)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index + 1));
      if (match) {
        const name = match[0];
        let valueIndex = Object.keys(args).indexOf(name);
        if (valueIndex < 0) throw new Error(`Missing SQL parameter: ${name}`);
        valueIndex = values.push(args[name]);
        translated += `$${valueIndex}`;
        index += name.length;
        continue;
      }
    }
    translated += character;
  }
  translated = translated.replace(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi, 'AS "$1"');
  return { sql: translated, values };
}

function createPostgresDatabase(connectionString) {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX || 10),
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined
  });
  const transactions = new AsyncLocalStorage();

  async function query(sql, rawArgs) {
    const args = normalizeArguments(rawArgs);
    const converted = translatePostgresQuery(sql, args);
    const client = transactions.getStore() || pool;
    return converted.values.length
      ? client.query(converted.sql, converted.values)
      : client.query(converted.sql);
  }

  const db = {
    isPostgres: true,
    async get(sql, ...args) {
      const result = await query(sql, args);
      return result.rows[0];
    },
    async all(sql, ...args) {
      const result = await query(sql, args);
      return result.rows;
    },
    async run(sql, ...args) {
      const result = await query(sql, args);
      return { changes: result.rowCount };
    },
    async exec(sql) {
      await query(sql, []);
    },
    async transaction(callback) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await transactions.run(client, callback);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async withAdvisoryLock(lockId, callback) {
      const client = await pool.connect();
      try {
        const acquired = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [lockId]);
        if (!acquired.rows[0].acquired) return null;
        try {
          return await callback();
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
        }
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    }
  };
  return db;
}

function createSqliteDatabase(databasePath) {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  let lock = Promise.resolve();
  const transactions = new AsyncLocalStorage();

  async function locked(operation) {
    const previous = lock;
    let release;
    lock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function query(operation) {
    if (transactions.getStore() === sqlite) return operation();
    return locked(operation);
  }

  const db = {
    isPostgres: false,
    async get(sql, ...args) {
      const values = normalizeArguments(args);
      return query(() => Array.isArray(values)
        ? sqlite.prepare(sql).get(...values)
        : sqlite.prepare(sql).get(values));
    },
    async all(sql, ...args) {
      const values = normalizeArguments(args);
      return query(() => Array.isArray(values)
        ? sqlite.prepare(sql).all(...values)
        : sqlite.prepare(sql).all(values));
    },
    async run(sql, ...args) {
      const values = normalizeArguments(args);
      return query(() => Array.isArray(values)
        ? sqlite.prepare(sql).run(...values)
        : sqlite.prepare(sql).run(values));
    },
    async exec(sql) {
      return query(() => sqlite.exec(sql));
    },
    async backup(destination) {
      return query(() => sqlite.backup(destination));
    },
    async transaction(callback) {
      return locked(async () => {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const result = await transactions.run(sqlite, callback);
          sqlite.exec("COMMIT");
          return result;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      });
    },
    async withAdvisoryLock(lockId, callback) {
      return locked(callback);
    },
    async close() {
      await locked(() => sqlite.close());
    }
  };
  return db;
}

async function createDatabase(databasePath = process.env.DATABASE_URL || process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH) {
  const isPostgres = /^postgres(?:ql)?:\/\//i.test(databasePath);
  const db = isPostgres ? createPostgresDatabase(databasePath) : createSqliteDatabase(databasePath);
  try {
    await db.exec(schema);
    if (!db.isPostgres) {
      const userColumns = new Set((await db.all("PRAGMA table_info(users)")).map((column) => column.name));
      if (!userColumns.has("email_verified_at")) await db.exec("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
      if (!userColumns.has("phone_verified_at")) await db.exec("ALTER TABLE users ADD COLUMN phone_verified_at TEXT");
      if (!userColumns.has("identity_status")) {
        await db.exec("ALTER TABLE users ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'unverified'");
      }
      if (!userColumns.has("email_notifications_enabled")) {
        await db.exec("ALTER TABLE users ADD COLUMN email_notifications_enabled INTEGER NOT NULL DEFAULT 0");
      }
      if (!userColumns.has("sms_notifications_enabled")) {
        await db.exec("ALTER TABLE users ADD COLUMN sms_notifications_enabled INTEGER NOT NULL DEFAULT 0");
      }
      const notificationColumns = new Set((await db.all("PRAGMA table_info(notifications)")).map((column) => column.name));
      if (!notificationColumns.has("attempts")) await db.exec("ALTER TABLE notifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
      if (!notificationColumns.has("next_attempt_at")) await db.exec("ALTER TABLE notifications ADD COLUMN next_attempt_at TEXT");
      if (!notificationColumns.has("locked_until")) await db.exec("ALTER TABLE notifications ADD COLUMN locked_until TEXT");
      if (!notificationColumns.has("last_error")) await db.exec("ALTER TABLE notifications ADD COLUMN last_error TEXT");
      const paymentColumns = new Set((await db.all("PRAGMA table_info(payments)")).map((column) => column.name));
      for (const [name, definition] of [
        ["order_id", "TEXT"],
        ["provider", "TEXT NOT NULL DEFAULT 'sandbox'"],
        ["provider_reference", "TEXT"],
        ["poll_url", "TEXT"],
        ["redirect_url", "TEXT"]
      ]) {
        if (!paymentColumns.has(name)) await db.exec(`ALTER TABLE payments ADD COLUMN ${name} ${definition}`);
      }
      const documentColumns = new Set((await db.all("PRAGMA table_info(identity_documents)")).map((column) => column.name));
      if (!documentColumns.has("policy_version")) await db.exec("ALTER TABLE identity_documents ADD COLUMN policy_version TEXT");
      if (!documentColumns.has("consented_at")) await db.exec("ALTER TABLE identity_documents ADD COLUMN consented_at TEXT");
    }
    const rawTransaction = db.transaction.bind(db);
    db.prepare = (sql) => ({
      get: (...args) => db.get(sql, ...args),
      all: (...args) => db.all(sql, ...args),
      run: (...args) => db.run(sql, ...args)
    });
    db.transaction = (callback) => {
      const run = () => rawTransaction(callback);
      run.immediate = run;
      return run;
    };
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

module.exports = { createDatabase };
