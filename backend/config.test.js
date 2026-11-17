const assert = require("node:assert/strict");
const test = require("node:test");
const { validateConfiguration } = require("./config");

const validProductionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://app:secret@db.example.com:5432/zimconnect",
  PUBLIC_BASE_URL: "https://zimconnect.example.com",
  CORS_ORIGINS: "https://zimconnect.example.com",
  TRUST_PROXY_HOPS: "0",
  BACKUP_KMS_KEY_ID: "arn:aws:kms:af-south-1:123456789012:key/example",
  BACKUP_S3_BUCKET: "zimconnect-encrypted-backups",
  AWS_REGION: "af-south-1",
  IDENTITY_RETENTION_DAYS: "30",
  GPS_RETENTION_DAYS: "7",
  VIDEO_RETENTION_DAYS: "30",
  BACKUP_RETENTION_DAYS: "30"
};

test("production configuration accepts explicit proxy and retention settings", () => {
  assert.doesNotThrow(() => validateConfiguration(validProductionEnvironment));
});

test("production configuration rejects missing proxy and retention settings", () => {
  const missingProxyHops = { ...validProductionEnvironment };
  delete missingProxyHops.TRUST_PROXY_HOPS;
  assert.throws(() => validateConfiguration(missingProxyHops), /TRUST_PROXY_HOPS/);

  const missingRetention = { ...validProductionEnvironment };
  delete missingRetention.GPS_RETENTION_DAYS;
  assert.throws(() => validateConfiguration(missingRetention), /GPS_RETENTION_DAYS/);
});

test("production configuration rejects invalid explicit settings", () => {
  assert.throws(() => validateConfiguration({
    ...validProductionEnvironment,
    TRUST_PROXY_HOPS: "1.5"
  }), /TRUST_PROXY_HOPS/);

  assert.throws(() => validateConfiguration({
    ...validProductionEnvironment,
    VIDEO_RETENTION_DAYS: "0"
  }), /VIDEO_RETENTION_DAYS/);
});
