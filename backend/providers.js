const nodemailer = require("nodemailer");
const OpenAI = require("openai");
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const {
  S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, GetObjectCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { HttpError } = require("./errors");

let cachedS3Client;

const PAYNOW_BASE_URL = "https://www.paynow.co.zw";

function paynowKey() {
  const key = process.env.PAYNOW_INTEGRATION_KEY;
  if (!process.env.PAYNOW_INTEGRATION_ID || !key) {
    throw new HttpError(503, "Paynow payments are not configured.");
  }
  return key;
}

function paynowHash(entries) {
  return crypto.createHash("sha512")
    .update(entries.filter(([name]) => name.toLowerCase() !== "hash").map(([, value]) => value).join("") + paynowKey())
    .digest("hex")
    .toUpperCase();
}

function verifyPaynowHash(entries) {
  const hashEntry = entries.find(([name]) => name.toLowerCase() === "hash");
  if (!hashEntry || !/^[A-Fa-f0-9]{128}$/.test(hashEntry[1])) return false;
  const expected = Buffer.from(paynowHash(entries), "hex");
  const received = Buffer.from(hashEntry[1], "hex");
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function parsePaynowMessage(body) {
  const params = new URLSearchParams(body);
  const entries = Array.from(params.entries());
  if (!entries.length || entries.some(([, value]) => value.length > 4096)) {
    throw new HttpError(502, "Paynow returned an invalid response.");
  }
  const fields = {};
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    if (Object.hasOwn(fields, key)) throw new HttpError(502, "Paynow returned duplicate response fields.");
    fields[key] = value;
  }
  return { entries, fields };
}

function paynowUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !(url.hostname === "paynow.co.zw" || url.hostname.endsWith(".paynow.co.zw"))) {
      throw new Error("Untrusted Paynow URL");
    }
    return url.toString();
  } catch (error) {
    throw new HttpError(502, "Paynow returned an invalid payment URL.");
  }
}

async function postPaynow(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new HttpError(502, "Paynow could not be reached.");
  }
  if (!response.ok) throw new HttpError(502, "Paynow rejected the payment request.");
  const text = await response.text();
  if (text.length > 16000) throw new HttpError(502, "Paynow returned an oversized response.");
  return parsePaynowMessage(text);
}

async function initiatePaynowPayment({ reference, amountCents, email, returnUrl, resultUrl }) {
  const fields = [
    ["id", process.env.PAYNOW_INTEGRATION_ID],
    ["reference", reference],
    ["amount", (amountCents / 100).toFixed(2)],
    ["additionalinfo", `ZimConnect order ${reference}`],
    ["returnurl", returnUrl],
    ["resulturl", resultUrl],
    ["authemail", email],
    ["status", "Message"]
  ];
  const payload = new URLSearchParams([...fields, ["hash", paynowHash(fields)]]);
  const { entries, fields: response } = await postPaynow(`${PAYNOW_BASE_URL}/interface/initiatetransaction`, payload);
  if (response.status !== "ok" || !verifyPaynowHash(entries)) {
    throw new HttpError(502, "Paynow could not authenticate the checkout response.");
  }
  if (!response.browserurl || !response.pollurl) {
    throw new HttpError(502, "Paynow returned an incomplete checkout response.");
  }
  return {
    checkoutUrl: paynowUrl(response.browserurl),
    pollUrl: paynowUrl(response.pollurl),
    paynowReference: response.paynowreference || null
  };
}

async function pollPaynowTransaction(pollUrl) {
  const { entries, fields } = await postPaynow(paynowUrl(pollUrl), "");
  if (!verifyPaynowHash(entries)) throw new HttpError(502, "Paynow status response could not be authenticated.");
  return {
    reference: fields.reference,
    amount: fields.amount,
    paynowReference: fields.paynowreference,
    status: fields.status
  };
}

function verifyPaynowCallback(fields) {
  return verifyPaynowHash(Object.entries(fields));
}

function s3Client() {
  if (!process.env.AWS_REGION) {
    throw new HttpError(503, "Private object storage is not configured.");
  }
  if (!cachedS3Client) {
    cachedS3Client = new S3Client({
      region: process.env.AWS_REGION,
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: Boolean(process.env.S3_ENDPOINT)
    });
  }
  return cachedS3Client;
}

async function uploadEncryptedBackup(filePath) {
  const bucket = process.env.BACKUP_S3_BUCKET;
  if (!bucket) throw new HttpError(503, "Off-site backup storage is not configured.");
  const fileName = require("node:path").basename(filePath);
  await s3Client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: `encrypted-backups/${fileName}`,
    Body: fs.createReadStream(filePath),
    ContentType: "application/octet-stream",
    ServerSideEncryption: "AES256"
  }));
}

async function createPrivateUploadUrl(key, contentType, expiresIn = 300) {
  if (!process.env.S3_BUCKET) throw new HttpError(503, "Private object storage is not configured.");
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
    ServerSideEncryption: "AES256"
  });
  return getSignedUrl(s3Client(), command, { expiresIn });
}

async function inspectPrivateObject(key) {
  const result = await s3Client().send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  return { size: result.ContentLength, contentType: result.ContentType, etag: result.ETag };
}

async function validatePrivateObject(key, contentType) {
  const response = await s3Client().send(new GetObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Range: "bytes=0-15"
  }));
  const chunks = [];
  for await (const chunk of response.Body) chunks.push(Buffer.from(chunk));
  const header = Buffer.concat(chunks);
  const valid = contentType === "image/jpeg"
    ? header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
    : contentType === "image/png"
      ? header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : contentType === "application/pdf"
        ? header.subarray(0, 5).toString("ascii") === "%PDF-"
        : contentType === "video/mp4"
          ? header.subarray(4, 8).toString("ascii") === "ftyp"
          : contentType === "video/webm"
            ? header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
            : false;
  if (!valid) throw new HttpError(400, "Uploaded file content does not match its declared type.");
}

async function createPrivateDownloadUrl(key) {
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    ResponseContentType: "application/octet-stream",
    ResponseContentDisposition: "attachment"
  });
  return getSignedUrl(s3Client(), command, { expiresIn: 60 });
}

async function deletePrivateObject(key) {
  await s3Client().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
}

async function promotePrivateObject(sourceKey, destinationKey, etag) {
  const copySource = `${process.env.S3_BUCKET}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`;
  try {
    await s3Client().send(new CopyObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: destinationKey,
      CopySource: copySource,
      CopySourceIfMatch: etag,
      ServerSideEncryption: "AES256"
    }));
  } catch (error) {
    if (error.$metadata && error.$metadata.httpStatusCode === 412) {
      throw new HttpError(409, "Uploaded file changed during scanning. Start a new upload.");
    }
    throw error;
  }
}

async function scanPrivateObject(key) {
  const host = process.env.CLAMD_HOST;
  const port = Number(process.env.CLAMD_PORT || 3310);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(503, "Upload malware scanning is not configured.");
  }
  const object = await s3Client().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  if (!object.Body) throw new HttpError(502, "Uploaded object could not be scanned.");

  const socket = net.createConnection({ host, port });
  socket.setTimeout(30000);
  const result = new Promise((resolve, reject) => {
    let response = "";
    socket.once("error", () => reject(new HttpError(503, "Upload malware scanner is unavailable.")));
    socket.once("timeout", () => {
      socket.destroy();
      reject(new HttpError(503, "Upload malware scan timed out."));
    });
    socket.once("close", () => reject(new HttpError(503, "Upload malware scanner closed the connection unexpectedly.")));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("FOUND")) {
        socket.destroy();
        reject(new HttpError(422, "Uploaded file failed malware scanning."));
      } else if (response.includes(": OK")) {
        socket.end();
        resolve();
      } else if (response.includes("ERROR")) {
        socket.destroy();
        reject(new HttpError(503, "Upload malware scanner could not scan the file."));
      } else if (response.length > 2048) {
        socket.destroy();
        reject(new HttpError(502, "Upload scanner returned an invalid response."));
      }
    });
  });
  result.catch(() => {});

  try {
    await new Promise((resolve, reject) => {
      const onError = () => reject(new HttpError(503, "Upload malware scanner is unavailable."));
      const onTimeout = () => reject(new HttpError(503, "Upload malware scan timed out."));
      socket.once("connect", () => {
        socket.off("error", onError);
        socket.off("timeout", onTimeout);
        resolve();
      });
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
    });
    socket.write(Buffer.from("zINSTREAM\0"));
    for await (const chunk of object.Body) {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(chunk.length);
      if (!socket.write(Buffer.concat([length, chunk]))) {
        await new Promise((resolve) => socket.once("drain", resolve));
      }
    }
    socket.write(Buffer.alloc(4));
    await result;
  } finally {
    object.Body.destroy();
    socket.destroy();
  }
}

async function sendEmail({ to, subject, text, html }) {
  const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"];
  if (required.some((key) => !process.env[key])) {
    throw new HttpError(503, "Email delivery is not configured.");
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    requireTLS: process.env.NODE_ENV === "production" && process.env.SMTP_SECURE !== "true",
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
  });
  try {
    await transport.sendMail({ from: process.env.SMTP_FROM, to, subject, text, html });
  } finally {
    transport.close();
  }
}

async function sendSms({ to, message }) {
  const apiKey = process.env.AFRICASTALKING_API_KEY;
  const username = process.env.AFRICASTALKING_USERNAME;
  if (!apiKey || !username) throw new HttpError(503, "SMS delivery is not configured.");
  const body = new URLSearchParams({ username, to, message });
  if (process.env.AFRICASTALKING_SENDER_ID) body.set("from", process.env.AFRICASTALKING_SENDER_ID);
  let response;
  try {
    response = await fetch("https://api.africastalking.com/version1/messaging", {
      method: "POST",
      headers: {
        apiKey,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body,
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    throw new HttpError(502, "SMS provider could not be reached.");
  }
  if (!response.ok) throw new HttpError(502, "SMS provider could not deliver the message.");
  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new HttpError(502, "SMS provider returned an invalid response.");
  }
  const recipients = result.SMSMessageData && result.SMSMessageData.Recipients;
  if (!Array.isArray(recipients) || recipients.some((recipient) => recipient.statusCode !== 101)) {
    throw new HttpError(502, "SMS provider reported that the message was not accepted.");
  }
}

async function getDirections(origin, destination) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new HttpError(503, "Google Maps is not configured.");
  let response;
  try {
    response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline"
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode: "DRIVE"
      }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    throw new HttpError(502, "Google Maps could not be reached.");
  }
  if (!response.ok) throw new HttpError(502, "Google Maps could not calculate a route.");
  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new HttpError(502, "Google Maps returned an invalid response.");
  }
  const route = result.routes && result.routes[0];
  if (!route) throw new HttpError(404, "No route was found.");
  return {
    duration: route.duration,
    distanceMeters: route.distanceMeters,
    encodedPolyline: route.polyline && route.polyline.encodedPolyline
  };
}

function redactSensitiveText(value) {
  return value
    .replace(/\b\d{2}[- ]\d{6,7}[- ]?[A-Z][ -]?\d{2}\b/gi, "[REDACTED ID]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]")
    .replace(/(?:\+?\d[\d ()-]{7,}\d)/g, "[REDACTED PHONE]");
}

async function answerSupportQuestion(message) {
  if (!process.env.OPENAI_API_KEY) throw new HttpError(503, "AI support is not configured.");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 15000, maxRetries: 1 });
  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: "You are ZimConnect customer support. Give concise general guidance. Never request passwords, payment credentials, National ID numbers, or verification codes. Do not claim you performed an account action or can see live order data. For account-specific issues, direct the user to human support."
        },
        { role: "user", content: redactSensitiveText(message) }
      ],
      max_output_tokens: 500,
      store: false
    });
    return response.output_text;
  } catch (error) {
    throw new HttpError(502, "AI support provider could not process the request.");
  }
}

module.exports = {
  uploadEncryptedBackup,
  initiatePaynowPayment,
  pollPaynowTransaction,
  verifyPaynowCallback,
  createPrivateUploadUrl,
  inspectPrivateObject,
  validatePrivateObject,
  promotePrivateObject,
  scanPrivateObject,
  createPrivateDownloadUrl,
  deletePrivateObject,
  sendEmail,
  sendSms,
  getDirections,
  answerSupportQuestion
};
