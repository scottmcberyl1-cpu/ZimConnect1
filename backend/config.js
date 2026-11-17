require("dotenv").config();

function requiredProductionSettings(env) {
  const required = [
    "HOST",
    "PUBLIC_BASE_URL",
    "TRUST_PROXY_HOPS",
    "GOOGLE_MAPS_API_KEY",
    "S3_BUCKET",
    "AWS_REGION",
    "CLAMD_HOST",
    "CLAMD_PORT",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "SMTP_SECURE",
    "AFRICASTALKING_API_KEY",
    "AFRICASTALKING_USERNAME",
    "OPENAI_API_KEY",
    "BACKUP_ENCRYPTION_KEY",
    "IDENTITY_RETENTION_DAYS",
    "GPS_RETENTION_DAYS",
    "VIDEO_RETENTION_DAYS",
    "BACKUP_RETENTION_DAYS"
  ];
  return required.filter((name) => !env[name]);
}

function validateConfiguration(env = process.env) {
  if (env.NODE_ENV !== "production") return;
  const missing = requiredProductionSettings(env);
  if (missing.length) {
    throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
  }
  if (!env.PUBLIC_BASE_URL.startsWith("https://")) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production.");
  }
  if (env.S3_ENDPOINT && !env.S3_ENDPOINT.startsWith("https://")) {
    throw new Error("S3_ENDPOINT must use HTTPS in production.");
  }
  if (!Number.isInteger(Number(env.TRUST_PROXY_HOPS)) || Number(env.TRUST_PROXY_HOPS) < 0) {
    throw new Error("TRUST_PROXY_HOPS must be a non-negative integer.");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(env.BACKUP_ENCRYPTION_KEY)) {
    throw new Error("BACKUP_ENCRYPTION_KEY must be 32 bytes encoded as 64 hexadecimal characters.");
  }
  if (env.PAYMENT_MODE !== "sandbox") {
    throw new Error("PAYMENT_MODE must remain 'sandbox' until a live gateway is explicitly integrated.");
  }
  for (const name of ["IDENTITY_RETENTION_DAYS", "GPS_RETENTION_DAYS", "VIDEO_RETENTION_DAYS", "BACKUP_RETENTION_DAYS"]) {
    if (!Number.isInteger(Number(env[name])) || Number(env[name]) < 1 || Number(env[name]) > 3650) {
      throw new Error(`${name} must be between 1 and 3650 days.`);
    }
  }
}

module.exports = { validateConfiguration };
