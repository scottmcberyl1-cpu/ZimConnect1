require("dotenv").config();

function isEnabled(env, name) {
  return env[name] === "true";
}

function requiredProductionSettings(env) {
  const required = [
    "DATABASE_URL",
    "PUBLIC_BASE_URL",
    "CORS_ORIGINS",
    "BACKUP_KMS_KEY_ID",
    "BACKUP_S3_BUCKET",
    "AWS_REGION"
  ];
  if (isEnabled(env, "PAYNOW_ENABLED")) required.push("PAYNOW_INTEGRATION_ID", "PAYNOW_INTEGRATION_KEY");
  if (isEnabled(env, "IDENTITY_UPLOADS_ENABLED") || isEnabled(env, "VIDEO_UPLOADS_ENABLED")) {
    required.push("S3_BUCKET", "CLAMD_HOST", "CLAMD_PORT");
  }
  if (isEnabled(env, "IDENTITY_UPLOADS_ENABLED")) required.push("IDENTITY_POLICY_URL", "IDENTITY_POLICY_VERSION");
  if (isEnabled(env, "MAPS_ENABLED")) required.push("GOOGLE_MAPS_API_KEY");
  if (isEnabled(env, "AI_SUPPORT_ENABLED")) required.push("OPENAI_API_KEY");
  if (isEnabled(env, "EMAIL_ENABLED")) {
    required.push("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM");
  }
  if (isEnabled(env, "SMS_ENABLED")) required.push("AFRICASTALKING_API_KEY", "AFRICASTALKING_USERNAME");
  return required.filter((name) => !env[name]);
}

function validateConfiguration(env = process.env) {
  if (env.NODE_ENV !== "production") return;
  const missing = requiredProductionSettings(env);
  if (missing.length) {
    throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
  }
  let base;
  try {
    base = new URL(env.PUBLIC_BASE_URL);
  } catch (error) {
    throw new Error("PUBLIC_BASE_URL must be a valid HTTPS URL.");
  }
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS and cannot contain credentials.");
  }
  if (!/^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL)) {
    throw new Error("DATABASE_URL must use PostgreSQL in production.");
  }
  const proxyHops = Number(env.TRUST_PROXY_HOPS || 1);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) {
    throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 5.");
  }
  const origins = env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (!origins.length || origins.includes("*")) {
    throw new Error("CORS_ORIGINS must contain explicit HTTPS origins and cannot use '*'.");
  }
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch (error) {
      throw new Error("CORS_ORIGINS contains an invalid origin.");
    }
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error("Each CORS_ORIGINS entry must be an HTTPS origin without a path or credentials.");
    }
  }
  if (isEnabled(env, "PAYNOW_ENABLED") && !env.PUBLIC_BASE_URL) {
    throw new Error("PUBLIC_BASE_URL is required for Paynow callbacks.");
  }
  if (env.S3_ENDPOINT && !env.S3_ENDPOINT.startsWith("https://")) {
    throw new Error("S3_ENDPOINT must use HTTPS in production.");
  }
  for (const [name, fallback] of [
    ["IDENTITY_RETENTION_DAYS", 30],
    ["GPS_RETENTION_DAYS", 7],
    ["VIDEO_RETENTION_DAYS", 30],
    ["BACKUP_RETENTION_DAYS", 30]
  ]) {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > 3650) {
      throw new Error(`${name} must be between 1 and 3650 days.`);
    }
  }
}

module.exports = { validateConfiguration };
