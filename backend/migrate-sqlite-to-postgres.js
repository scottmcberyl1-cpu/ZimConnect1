require("./config");
const Database = require("better-sqlite3");
const path = require("node:path");
const { createDatabase } = require("./db");

const TABLES = [
  "users",
  "sessions",
  "email_verification_tokens",
  "phone_verification_codes",
  "notifications",
  "products",
  "orders",
  "order_items",
  "order_events",
  "payments",
  "identity_documents",
  "videos",
  "deliveries",
  "admin_audit_log"
];

async function migrate(sourcePath, connectionString) {
  if (!sourcePath || !connectionString || !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    throw new Error("Set DATABASE_PATH and a PostgreSQL DATABASE_URL before migrating.");
  }
  const resolvedSource = path.resolve(sourcePath);
  const source = new Database(resolvedSource, { readonly: true, fileMustExist: true });
  const destination = await createDatabase(connectionString);
  const counts = {};
  try {
    const availableTables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const table of TABLES) {
      if (!availableTables.has(table)) continue;
      const sourceColumns = source.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name);
      const destinationColumns = new Set((await destination.all(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?",
        table
      )).map((column) => column.column_name));
      const columns = sourceColumns.filter((column) => destinationColumns.has(column));
      if (!columns.length) continue;
      const quotedColumns = columns.map((column) => `"${column.replace(/"/g, '""')}"`).join(", ");
      const placeholders = columns.map(() => "?").join(", ");
      const insert = `INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      const rows = source.prepare(`SELECT ${quotedColumns} FROM "${table}"`).iterate();
      let batch = [];
      counts[table] = 0;
      for (const row of rows) {
        batch.push(columns.map((column) => row[column]));
        if (batch.length === 250) {
          counts[table] += await insertBatch(destination, insert, batch);
          batch = [];
        }
      }
      if (batch.length) counts[table] += await insertBatch(destination, insert, batch);
    }
    return counts;
  } finally {
    source.close();
    await destination.close();
  }
}

async function insertBatch(db, statement, rows) {
  return db.transaction(async () => {
    let inserted = 0;
    for (const values of rows) inserted += (await db.prepare(statement).run(...values)).changes;
    return inserted;
  })();
}

if (require.main === module) {
  migrate(process.env.DATABASE_PATH, process.env.DATABASE_URL)
    .then((counts) => console.log("SQLite rows copied to PostgreSQL:", counts))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { migrate };
