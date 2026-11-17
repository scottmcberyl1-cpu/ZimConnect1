require("./config");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createDatabase } = require("./db");

const MAGIC = Buffer.from("ZCBK1");
const DEFAULT_DATABASE_PATH = path.join(__dirname, "data", "zimconnect.sqlite");
const DEFAULT_BACKUP_DIRECTORY = path.join(__dirname, "backups");

function encryptionKey() {
  const value = process.env.BACKUP_ENCRYPTION_KEY || "";
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error("BACKUP_ENCRYPTION_KEY must be 32 bytes encoded as 64 hexadecimal characters.");
  }
  return Buffer.from(value, "hex");
}

async function createEncryptedBackup(db, backupDirectory = DEFAULT_BACKUP_DIRECTORY, retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30)) {
  const key = encryptionKey();
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "zimconnect-backup-"));
  fs.chmodSync(temporaryDirectory, 0o700);
  const snapshot = path.join(temporaryDirectory, "snapshot.sqlite");
  const backupPath = path.join(backupDirectory, `zimconnect-${timestamp}.enc`);
  try {
    await db.backup(snapshot);
    fs.chmodSync(snapshot, 0o600);
    const plaintext = fs.readFileSync(snapshot);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    fs.writeFileSync(backupPath, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600, flag: "wx" });
    purgeOldBackups(backupDirectory, retentionDays);
    return backupPath;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function purgeOldBackups(directory, retentionDays) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("Backup retention must be a positive number of days.");
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(directory)) {
    if (!/^zimconnect-[\dTZ-]+\.enc$/.test(name)) continue;
    const file = path.join(directory, name);
    const metadata = fs.lstatSync(file);
    if (metadata.isFile() && metadata.mtimeMs < cutoff) fs.unlinkSync(file);
  }
}

function decryptBackup(source, destination) {
  const input = fs.readFileSync(source);
  if (input.length < MAGIC.length + 12 + 16 || !input.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Backup file format is invalid.");
  }
  const key = encryptionKey();
  const ivStart = MAGIC.length;
  const tagStart = ivStart + 12;
  const ciphertextStart = tagStart + 16;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, input.subarray(ivStart, tagStart));
  decipher.setAuthTag(input.subarray(tagStart, ciphertextStart));
  const plaintext = Buffer.concat([
    decipher.update(input.subarray(ciphertextStart)),
    decipher.final()
  ]);
  fs.writeFileSync(destination, plaintext, { mode: 0o600, flag: "wx" });
}

async function restoreEncryptedBackup(source, databasePath = process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH) {
  const backupDirectory = path.resolve(process.env.BACKUP_DIRECTORY || DEFAULT_BACKUP_DIRECTORY);
  const resolvedSource = path.resolve(source);
  if (!resolvedSource.startsWith(`${backupDirectory}${path.sep}`)) {
    throw new Error("Restore source must be inside the configured backup directory.");
  }
  const resolvedDatabase = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolvedDatabase), { recursive: true });
  const restored = `${resolvedDatabase}.${crypto.randomUUID()}.restore`;
  let installed = false;
  try {
    decryptBackup(resolvedSource, restored);
    const check = new Database(restored, { readonly: true });
    try {
      if (check.pragma("integrity_check", { simple: true }) !== "ok") {
        throw new Error("Restored database failed its integrity check.");
      }
    } finally {
      check.close();
    }

    if (fs.existsSync(resolvedDatabase)) {
      const currentDb = new Database(resolvedDatabase);
      try {
        await createEncryptedBackup(
          currentDb,
          backupDirectory,
          Number(process.env.BACKUP_RETENTION_DAYS || 30)
        );
      } finally {
        currentDb.close();
      }
      fs.unlinkSync(resolvedDatabase);
    }
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${resolvedDatabase}${suffix}`;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
    fs.renameSync(restored, resolvedDatabase);
    installed = true;
  } finally {
    if (!installed && fs.existsSync(restored)) fs.unlinkSync(restored);
  }
}

async function main() {
  const action = process.argv[2];
  if (action === "create") {
    const db = createDatabase(process.env.DATABASE_PATH);
    try {
      const backup = await createEncryptedBackup(
        db,
        process.env.BACKUP_DIRECTORY || DEFAULT_BACKUP_DIRECTORY,
        Number(process.env.BACKUP_RETENTION_DAYS || 30)
      );
      console.log(`Encrypted backup created: ${backup}`);
    } finally {
      db.close();
    }
    return;
  }
  if (action === "restore") {
    if (!process.argv[3]) throw new Error("Provide the encrypted backup file path.");
    await restoreEncryptedBackup(process.argv[3]);
    console.log("Database restored. Restart the backend to resume service.");
    return;
  }
  throw new Error("Use 'create' or 'restore <backup-file>'.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createEncryptedBackup, decryptBackup, restoreEncryptedBackup, purgeOldBackups };
