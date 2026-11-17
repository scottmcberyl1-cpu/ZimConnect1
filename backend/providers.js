const nodemailer = require("nodemailer");
const OpenAI = require("openai");
const net = require("node:net");
const {
  S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, GetObjectCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { HttpError } = require("./errors");

let cachedS3Client;

function s3Client() {
  if (!process.env.S3_BUCKET || !process.env.AWS_REGION) {
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

async function createPrivateUploadUrl(key, contentType, expiresIn = 300) {
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
