require("./config");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { createWriteStream } = require("node:fs");
const { KMSClient, GenerateDataKeyCommand, DecryptCommand } = require("@aws-sdk/client-kms");
const Database = require("better-sqlite3");
const { createDatabase } = require("./db");
const { uploadEncryptedBackup } = require("./providers");

const MAGIC_V1 = Buffer.from("ZCBK1");
const MAGIC_KMS = Buffer.from("ZCBK2");
const DEFAULT_DATABASE_PATH = path.join(__dirname, "data", "zimconnect.sqlite");
const DEFAULT_BACKUP_DIRECTORY = path.join(__dirname, "backups");

function encryptionKey() {
  const value = process.env.BACKUP_ENCRYPTION_KEY || "";
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error("BACKUP_ENCRYPTION_KEY must be 32 bytes encoded as 64 hexadecimal characters.");
  }
  return Buffer.from(value, "hex");
}

async function createDataKey() {
  if (!process.env.BACKUP_KMS_KEY_ID) return { key: encryptionKey(), encryptedKey: null };
  const kms = new KMSClient({ region: process.env.AWS_REGION });
  const result = await kms.send(new GenerateDataKeyCommand({
    KeyId: process.env.BACKUP_KMS_KEY_ID,
    KeySpec: "AES_256"
  }));
  if (!result.Plaintext || !result.CiphertextBlob) throw new Error("AWS KMS did not return a backup data key.");
  return { key: Buffer.from(result.Plaintext), encryptedKey: Buffer.from(result.CiphertextBlob) };
}

function backupHeader(iv, encryptedKey) {
  if (!encryptedKey) return { magic: MAGIC_V1, bytes: Buffer.concat([MAGIC_V1, iv, Buffer.alloc(16)]) };
  if (encryptedKey.length > 65535) throw new Error("Encrypted backup key is too large.");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(encryptedKey.length);
  return {
    magic: MAGIC_KMS,
    bytes: Buffer.concat([MAGIC_KMS, iv, Buffer.alloc(16), length, encryptedKey])
  };
}

async function createEncryptedBackup(db, backupDirectory = DEFAULT_BACKUP_DIRECTORY, retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30)) {
  const file = db.isPostgres
    ? await createPostgresEncryptedBackup(backupDirectory, retentionDays)
    : await createSqliteEncryptedBackup(db, backupDirectory, retentionDays);
  if (process.env.BACKUP_S3_BUCKET) await uploadEncryptedBackup(file);
  return file;
}

async function createSqliteEncryptedBackup(db, backupDirectory, retentionDays) {
  const dataKey = await createDataKey();
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
    const header = backupHeader(iv, dataKey.encryptedKey);
    const cipher = crypto.createCipheriv("aes-256-gcm", dataKey.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    cipher.getAuthTag().copy(header.bytes, header.magic.length + iv.length);
    fs.writeFileSync(backupPath, Buffer.concat([header.bytes, ciphertext]), { mode: 0o600, flag: "wx" });
    purgeOldBackups(backupDirectory, retentionDays);
    return backupPath;
  } finally {
    dataKey.key.fill(0);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function postgresToolEnvironment() {
  const url = new URL(process.env.DATABASE_URL);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: process.env.NODE_ENV === "production" ? "verify-full" : "prefer"
  };
}

async function createPostgresEncryptedBackup(backupDirectory, retentionDays) {
  const dataKey = await createDataKey();
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDirectory, `zimconnect-${timestamp}.enc`);
  const iv = crypto.randomBytes(12);
  const header = backupHeader(iv, dataKey.encryptedKey);
  fs.writeFileSync(backupPath, header.bytes, { mode: 0o600, flag: "wx" });
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey.key, iv);
  const child = spawn("pg_dump", ["--format=custom", "--no-owner", "--no-acl"], {
    env: postgresToolEnvironment(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("pg_dump failed")));
  });
  exited.catch(() => {});
  try {
    await pipeline(child.stdout, cipher, createWriteStream(backupPath, { flags: "a", mode: 0o600 }));
    await exited;
    const tag = cipher.getAuthTag();
    const descriptor = fs.openSync(backupPath, "r+");
    try {
      fs.writeSync(descriptor, tag, 0, tag.length, header.magic.length + iv.length);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    purgeOldBackups(backupDirectory, retentionDays);
    return backupPath;
  } catch (error) {
    child.kill();
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    throw new Error(`PostgreSQL backup failed${stderr ? `: ${stderr.trim().slice(0, 500)}` : "."}`);
  } finally {
    dataKey.key.fill(0);
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
  if (input.length < MAGIC_V1.length + 12 + 16 || !input.subarray(0, MAGIC_V1.length).equals(MAGIC_V1)) {
    throw new Error("Backup file format is invalid.");
  }
  const key = encryptionKey();
  const ivStart = MAGIC_V1.length;
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

async function decryptBackupToFile(source, destination) {
  const descriptor = fs.openSync(source, "r");
  let dataKey;
  try {
    const prefix = Buffer.alloc(MAGIC_V1.length + 12 + 16 + 2);
    const prefixLength = fs.readSync(descriptor, prefix, 0, prefix.length, 0);
    const magic = prefix.subarray(0, MAGIC_V1.length);
    if (prefixLength < MAGIC_V1.length + 12 + 16 ||
        (!magic.equals(MAGIC_V1) && !magic.equals(MAGIC_KMS))) {
      throw new Error("Backup file format is invalid.");
    }
    const ivStart = MAGIC_V1.length;
    const tagStart = ivStart + 12;
    let dataOffset = tagStart + 16;
    if (magic.equals(MAGIC_KMS)) {
      if (prefixLength < dataOffset + 2) throw new Error("Backup file format is invalid.");
      const encryptedKeyLength = prefix.readUInt16BE(dataOffset);
      dataOffset += 2;
      const encryptedKey = Buffer.alloc(encryptedKeyLength);
      if (!encryptedKeyLength || fs.readSync(descriptor, encryptedKey, 0, encryptedKeyLength, dataOffset) !== encryptedKeyLength) {
        throw new Error("Backup file format is invalid.");
      }
      const kms = new KMSClient({ region: process.env.AWS_REGION });
      const result = await kms.send(new DecryptCommand({ CiphertextBlob: encryptedKey }));
      if (!result.Plaintext) throw new Error("AWS KMS could not decrypt the backup key.");
      dataKey = Buffer.from(result.Plaintext);
      dataOffset += encryptedKeyLength;
    } else {
      dataKey = encryptionKey();
    }
    const headerLength = magic.equals(MAGIC_KMS) ? dataOffset : tagStart + 16;
    const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey, prefix.subarray(ivStart, tagStart));
    decipher.setAuthTag(prefix.subarray(tagStart, tagStart + 16));
    await pipeline(
      fs.createReadStream(source, { start: headerLength }),
      decipher,
      createWriteStream(destination, { flags: "wx", mode: 0o600 })
    );
  } finally {
    if (dataKey) dataKey.fill(0);
    fs.closeSync(descriptor);
  }
}

async function restoreEncryptedBackup(source, databasePath = process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH) {
  const backupDirectory = path.resolve(process.env.BACKUP_DIRECTORY || DEFAULT_BACKUP_DIRECTORY);
  const resolvedSource = path.resolve(source);
  if (!resolvedSource.startsWith(`${backupDirectory}${path.sep}`)) {
    throw new Error("Restore source must be inside the configured backup directory.");
  }
  if (process.env.DATABASE_URL) {
    return restorePostgresEncryptedBackup(resolvedSource, backupDirectory);
  }
  const resolvedDatabase = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolvedDatabase), { recursive: true });
  const restored = `${resolvedDatabase}.${crypto.randomUUID()}.restore`;
  let installed = false;
  try {
    await decryptBackupToFile(resolvedSource, restored);
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

async function restorePostgresEncryptedBackup(source, backupDirectory) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "zimconnect-restore-"));
  fs.chmodSync(temporaryDirectory, 0o700);
  const dumpPath = path.join(temporaryDirectory, "restore.dump");
  try {
    await decryptBackupToFile(source, dumpPath);
    await runPostgresTool("pg_restore", ["--list", dumpPath]);
    const db = await createDatabase(process.env.DATABASE_URL);
    try {
      await createEncryptedBackup(db, backupDirectory, Number(process.env.BACKUP_RETENTION_DAYS || 30));
    } finally {
      await db.close();
    }
    await runPostgresTool("pg_restore", [
      "--single-transaction", "--exit-on-error", "--clean", "--if-exists", "--no-owner", "--no-acl", dumpPath
    ]);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runPostgresTool(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: postgresToolEnvironment(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once("error", () => reject(new Error(`${command} is unavailable.`)));
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} failed${stderr ? `: ${stderr.trim().slice(0, 500)}` : "."}`)));
  });
}

async function main() {
  const action = process.argv[2];
  if (action === "create") {
    const db = await createDatabase(process.env.DATABASE_URL || process.env.DATABASE_PATH);
    try {
      const backup = await createEncryptedBackup(
        db,
        process.env.BACKUP_DIRECTORY || DEFAULT_BACKUP_DIRECTORY,
        Number(process.env.BACKUP_RETENTION_DAYS || 30)
      );
      console.log(`Encrypted backup created: ${backup}`);
    } finally {
      await db.close();
    }
    return;
  }
  if (action === "restore") {
    if (!process.argv[3]) throw new Error("Provide the encrypted backup file path.");
    await restoreEncryptedBackup(process.argv[3], process.env.DATABASE_URL || process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH);
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

module.exports = { createEncryptedBackup, decryptBackup, decryptBackupToFile, restoreEncryptedBackup, purgeOldBackups };
