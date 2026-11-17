const crypto = require("node:crypto");
const { rateLimit } = require("express-rate-limit");
const { HttpError } = require("./errors");
const defaultProviders = require("./providers");
const { registerCommerceRoutes } = require("./orders");

const IDENTITY_TYPES = new Set(["id_front", "id_back", "selfie"]);
const IDENTITY_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);
const VIDEO_CONTENT_TYPES = new Set(["video/mp4", "video/webm"]);
const MAX_IDENTITY_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

function validCoordinate(value, minimum, maximum, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new HttpError(400, `${name} is outside the valid range.`);
  }
  return value;
}

function retentionDate(name, fallback) {
  const days = Number(process.env[name] || fallback);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new HttpError(500, `${name} must be configured as a positive number of days.`);
  }
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function registerIntegrationRoutes({ app, db, requireAuth, requireRole, providers = defaultProviders }) {
  const gpsLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    keyGenerator: (req) => req.auth.user.id,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: "GPS update limit reached. Try again shortly." })
  });
  const providerLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    keyGenerator: (req) => req.auth.user.id,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: "Provider request limit reached. Try again shortly." })
  });
  const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    keyGenerator: (req) => req.auth.user.id,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: "AI support request limit reached. Try again shortly." })
  });
  const notificationRetryLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 3,
    keyGenerator: (req) => req.auth.user.id,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: "Notification retry limit reached. Try again shortly." })
  });
  const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    keyGenerator: (req) => req.auth.user.id,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: "Upload request limit reached. Try again later." })
  });

  registerCommerceRoutes({ app, db, requireAuth, requireRole, providers });

  app.get("/api/notifications", requireAuth, async (req, res) => {
    const rows = await db.prepare(`
      SELECT id, channel, subject, body, status, created_at AS createdAt, read_at AS readAt
      FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(req.auth.user.id);
    res.json({ notifications: rows });
  });

  app.patch("/api/notifications/:id/read", requireAuth, async (req, res) => {
    const result = await db.prepare(`
      UPDATE notifications SET status = 'read', read_at = ?
      WHERE id = ? AND user_id = ? AND status IN ('queued', 'sent')
    `).run(new Date().toISOString(), req.params.id, req.auth.user.id);
    if (!result.changes) throw new HttpError(404, "Notification not found.");
    res.status(204).end();
  });

  app.post("/api/notifications/:id/retry", requireAuth, notificationRetryLimiter, async (req, res) => {
    const notification = await db.prepare(`
      SELECT n.channel, u.email_notifications_enabled, u.sms_notifications_enabled
      FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.id = ? AND n.user_id = ? AND n.status = 'failed'
    `).get(req.params.id, req.auth.user.id);
    if (!notification || !["email", "sms"].includes(notification.channel)) {
      throw new HttpError(404, "Failed notification not found.");
    }
    if ((notification.channel === "email" && !notification.email_notifications_enabled) ||
        (notification.channel === "sms" && !notification.sms_notifications_enabled)) {
      throw new HttpError(409, "Enable the notification channel before retrying.");
    }
    const result = await db.prepare(`
      UPDATE notifications SET status = 'queued', attempts = 0, next_attempt_at = NULL, last_error = NULL
      WHERE id = ? AND user_id = ? AND channel IN ('email', 'sms') AND status = 'failed'
    `).run(req.params.id, req.auth.user.id);
    if (!result.changes) throw new HttpError(404, "Failed notification not found.");
    res.status(202).json({ id: req.params.id, status: "queued" });
  });

  app.post("/api/identity/documents", requireAuth, uploadLimiter, async (req, res) => {
    if (process.env.IDENTITY_UPLOADS_ENABLED !== "true" || !process.env.IDENTITY_POLICY_URL ||
        !process.env.IDENTITY_POLICY_VERSION) {
      throw new HttpError(503, "Identity uploads are not enabled until the verification policy is configured.");
    }
    const { documentType, contentType, fileSize } = req.body || {};
    if (!req.body || req.body.legalConsent !== true) {
      throw new HttpError(400, "Consent to the identity-document policy is required.");
    }
    if (!IDENTITY_TYPES.has(documentType) || !IDENTITY_CONTENT_TYPES.has(contentType) ||
        !Number.isInteger(fileSize) || fileSize < 1 || fileSize > MAX_IDENTITY_BYTES) {
      throw new HttpError(400, "Provide a supported identity document type, content type, and size up to 10 MB.");
    }
    const activeCount = (await db.prepare(`
      SELECT COUNT(*) AS count FROM identity_documents
      WHERE user_id = ? AND (status IN ('upload_pending', 'pending_review') OR delete_after > ?)
    `).get(req.auth.user.id, new Date().toISOString())).count;
    if (activeCount >= 10) throw new HttpError(429, "Too many active identity documents.");
    const id = crypto.randomUUID();
    const stagingKey = `identity-staging/${req.auth.user.id}/${id}`;
    const uploadUrl = await providers.createPrivateUploadUrl(stagingKey, contentType);
    const consentedAt = new Date().toISOString();
    await db.prepare(`
      INSERT INTO identity_documents
        (id, user_id, document_type, object_key, content_type, file_size, status, created_at, policy_version, consented_at)
      VALUES (?, ?, ?, ?, ?, ?, 'upload_pending', ?, ?, ?)
    `).run(id, req.auth.user.id, documentType, stagingKey, contentType, fileSize, consentedAt,
      process.env.IDENTITY_POLICY_VERSION, consentedAt);
    await db.prepare("UPDATE users SET identity_status = 'pending', updated_at = ? WHERE id = ?")
      .run(consentedAt, req.auth.user.id);
    res.status(201).json({
      id,
      uploadUrl,
      method: "PUT",
      headers: { "Content-Type": contentType, "x-amz-server-side-encryption": "AES256" },
      expiresInSeconds: 300
    });
  });

  app.post("/api/identity/documents/:id/complete", requireAuth, async (req, res) => {
    const document = await db.prepare("SELECT * FROM identity_documents WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.auth.user.id);
    if (!document || document.status !== "upload_pending") throw new HttpError(404, "Pending identity upload not found.");
    const object = await providers.inspectPrivateObject(document.object_key);
    if (object.size !== document.file_size || object.contentType !== document.content_type) {
      await providers.deletePrivateObject(document.object_key);
      await db.prepare("DELETE FROM identity_documents WHERE id = ?").run(document.id);
      throw new HttpError(400, "Uploaded file did not match the declared type or size.");
    }
    try {
      await providers.validatePrivateObject(document.object_key, document.content_type);
      await providers.scanPrivateObject(document.object_key);
    } catch (error) {
      if (error.status === 400 || error.status === 422) {
        await providers.deletePrivateObject(document.object_key);
        await db.prepare("DELETE FROM identity_documents WHERE id = ?").run(document.id);
      }
      throw error;
    }
    const finalKey = `identity/${req.auth.user.id}/${document.id}`;
    await providers.promotePrivateObject(document.object_key, finalKey, object.etag);
    await providers.deletePrivateObject(document.object_key);
    await db.prepare("UPDATE identity_documents SET object_key = ?, status = 'pending_review', delete_after = ? WHERE id = ?")
      .run(finalKey, retentionDate("IDENTITY_RETENTION_DAYS", 30), document.id);
    res.json({ id: document.id, status: "pending_review" });
  });

  app.get("/api/identity/documents", requireAuth, async (req, res) => {
    const documents = await db.prepare(`
      SELECT id, document_type AS documentType, status, created_at AS createdAt, reviewed_at AS reviewedAt
      FROM identity_documents WHERE user_id = ? ORDER BY created_at DESC
    `).all(req.auth.user.id);
    res.json({ documents });
  });

  app.delete("/api/identity/documents/:id", requireAuth, async (req, res) => {
    const document = await db.prepare("SELECT object_key FROM identity_documents WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.auth.user.id);
    if (!document) throw new HttpError(404, "Identity document not found.");
    await providers.deletePrivateObject(document.object_key);
    await db.prepare("DELETE FROM identity_documents WHERE id = ?").run(req.params.id);
    res.status(204).end();
  });

  app.get("/api/admin/identity/documents", requireAuth, requireRole("admin"), async (req, res) => {
    const documents = await db.prepare(`
      SELECT d.id, d.user_id AS userId, u.full_name AS ownerName, d.document_type AS documentType,
        d.content_type AS contentType, d.file_size AS fileSize, d.status, d.created_at AS createdAt
      FROM identity_documents d JOIN users u ON u.id = d.user_id
      WHERE d.status = 'pending_review' ORDER BY d.created_at ASC LIMIT 100
    `).all();
    res.json({ documents });
  });

  app.get("/api/admin/identity/documents/:id/download", requireAuth, requireRole("admin"), async (req, res) => {
    const document = await db.prepare("SELECT object_key, status FROM identity_documents WHERE id = ?").get(req.params.id);
    if (!document || document.status !== "pending_review") throw new HttpError(404, "Pending document not found.");
    res.set("Cache-Control", "no-store");
    res.json({ downloadUrl: await providers.createPrivateDownloadUrl(document.object_key), expiresInSeconds: 60 });
  });

  app.patch("/api/admin/identity/documents/:id", requireAuth, requireRole("admin"), async (req, res) => {
    const status = req.body && req.body.status;
    if (!["approved", "rejected"].includes(status)) throw new HttpError(400, "Status must be approved or rejected.");
    const deleteAfter = retentionDate("IDENTITY_RETENTION_DAYS", 30);
    await db.transaction(async () => {
      const current = await db.prepare("SELECT user_id FROM identity_documents WHERE id = ? AND status = 'pending_review'")
        .get(req.params.id);
      if (!current) throw new HttpError(404, "Pending document not found.");
      await db.prepare(`
        UPDATE identity_documents SET status = ?, reviewed_at = ?, reviewed_by = ?, delete_after = ?
        WHERE id = ? AND status = 'pending_review'
      `).run(status, new Date().toISOString(), req.auth.user.id, deleteAfter, req.params.id);
      const verifiedDocuments = (await db.prepare(`
        SELECT COUNT(DISTINCT document_type) AS count FROM identity_documents
        WHERE user_id = ? AND status = 'approved'
      `).get(current.user_id)).count;
      const identityStatus = status === "rejected"
        ? "rejected"
        : verifiedDocuments === 3 ? "verified" : "pending";
      await db.prepare("UPDATE users SET identity_status = ?, updated_at = ? WHERE id = ?")
        .run(identityStatus, new Date().toISOString(), current.user_id);
      await audit(db, req.auth.user.id, "identity.review", "identity_document", req.params.id, { status });
      await addNotification(db, current.user_id, "Identity verification reviewed", `Your identity submission was ${status}.`);
    })();
    res.json({ id: req.params.id, status, deleteAfter });
  });

  app.post("/api/videos/upload-url", requireAuth, uploadLimiter, async (req, res) => {
    if (process.env.VIDEO_UPLOADS_ENABLED !== "true") {
      throw new HttpError(503, "Video uploads are not enabled.");
    }
    const { contentType, fileSize } = req.body || {};
    if (!VIDEO_CONTENT_TYPES.has(contentType) || !Number.isInteger(fileSize) || fileSize < 1 || fileSize > MAX_VIDEO_BYTES) {
      throw new HttpError(400, "Provide a supported video type and size up to 100 MB.");
    }
    const usage = await db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS bytes FROM videos
      WHERE user_id = ? AND (
        status IN ('upload_pending', 'pending_review') OR
        delete_after IS NULL OR delete_after > ?
      )
    `).get(req.auth.user.id, new Date().toISOString());
    if (usage.count >= 10 || usage.bytes + fileSize > 500 * 1024 * 1024) {
      throw new HttpError(429, "Video storage quota reached.");
    }
    const id = crypto.randomUUID();
    const stagingKey = `video-staging/${req.auth.user.id}/${id}`;
    const uploadUrl = await providers.createPrivateUploadUrl(stagingKey, contentType);
    await db.prepare(`
      INSERT INTO videos (id, user_id, object_key, content_type, file_size, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'upload_pending', ?)
    `).run(id, req.auth.user.id, stagingKey, contentType, fileSize, new Date().toISOString());
    res.status(201).json({
      id,
      uploadUrl,
      method: "PUT",
      headers: { "Content-Type": contentType, "x-amz-server-side-encryption": "AES256" },
      expiresInSeconds: 300
    });
  });

  app.post("/api/videos/:id/complete", requireAuth, async (req, res) => {
    const video = await db.prepare("SELECT * FROM videos WHERE id = ? AND user_id = ?").get(req.params.id, req.auth.user.id);
    if (!video || video.status !== "upload_pending") throw new HttpError(404, "Pending video upload not found.");
    const object = await providers.inspectPrivateObject(video.object_key);
    if (object.size !== video.file_size || object.contentType !== video.content_type) {
      await providers.deletePrivateObject(video.object_key);
      await db.prepare("DELETE FROM videos WHERE id = ?").run(video.id);
      throw new HttpError(400, "Uploaded file did not match the declared type or size.");
    }
    try {
      await providers.validatePrivateObject(video.object_key, video.content_type);
      await providers.scanPrivateObject(video.object_key);
    } catch (error) {
      if (error.status === 400 || error.status === 422) {
        await providers.deletePrivateObject(video.object_key);
        await db.prepare("DELETE FROM videos WHERE id = ?").run(video.id);
      }
      throw error;
    }
    const finalKey = `videos/${req.auth.user.id}/${video.id}`;
    await providers.promotePrivateObject(video.object_key, finalKey, object.etag);
    await providers.deletePrivateObject(video.object_key);
    await db.prepare("UPDATE videos SET object_key = ?, status = 'pending_review', delete_after = ? WHERE id = ?")
      .run(finalKey, retentionDate("VIDEO_RETENTION_DAYS", 30), video.id);
    res.json({ id: video.id, status: "pending_review" });
  });

  app.get("/api/videos", requireAuth, async (req, res) => {
    const videos = await db.prepare(`
      SELECT id, status, created_at AS createdAt FROM videos
      WHERE user_id = ? ORDER BY created_at DESC
    `).all(req.auth.user.id);
    res.json({ videos });
  });

  app.get("/api/videos/:id/download", requireAuth, async (req, res) => {
    const video = await db.prepare("SELECT object_key FROM videos WHERE id = ? AND user_id = ? AND status = 'approved'")
      .get(req.params.id, req.auth.user.id);
    if (!video) throw new HttpError(404, "Approved video not found.");
    res.set("Cache-Control", "no-store");
    res.json({ downloadUrl: await providers.createPrivateDownloadUrl(video.object_key), expiresInSeconds: 60 });
  });

  app.get("/api/admin/videos", requireAuth, requireRole("admin"), async (req, res) => {
    res.json({
      videos: await db.prepare(`
        SELECT v.id, v.user_id AS userId, u.full_name AS ownerName, v.content_type AS contentType,
          v.file_size AS fileSize, v.status, v.created_at AS createdAt
        FROM videos v JOIN users u ON u.id = v.user_id
        WHERE v.status = 'pending_review' ORDER BY v.created_at ASC LIMIT 100
      `).all()
    });
  });

  app.get("/api/admin/videos/:id/download", requireAuth, requireRole("admin"), async (req, res) => {
    const video = await db.prepare("SELECT object_key, status FROM videos WHERE id = ?").get(req.params.id);
    if (!video || video.status !== "pending_review") throw new HttpError(404, "Pending video not found.");
    res.set("Cache-Control", "no-store");
    res.json({ downloadUrl: await providers.createPrivateDownloadUrl(video.object_key), expiresInSeconds: 60 });
  });

  app.patch("/api/admin/videos/:id", requireAuth, requireRole("admin"), async (req, res) => {
    const status = req.body && req.body.status;
    if (!["approved", "rejected"].includes(status)) throw new HttpError(400, "Status must be approved or rejected.");
    const deleteAfter = retentionDate("VIDEO_RETENTION_DAYS", 30);
    await db.transaction(async () => {
      const video = await db.prepare("SELECT user_id FROM videos WHERE id = ? AND status = 'pending_review'").get(req.params.id);
      if (!video) throw new HttpError(404, "Pending video not found.");
      await db.prepare("UPDATE videos SET status = ?, delete_after = ? WHERE id = ? AND status = 'pending_review'")
        .run(status, deleteAfter, req.params.id);
      await addNotification(db, video.user_id, "Video reviewed", `Your video was ${status}.`);
      await audit(db, req.auth.user.id, "video.review", "video", req.params.id, { status });
    })();
    res.json({ id: req.params.id, status, deleteAfter });
  });

  app.post("/api/maps/directions", requireAuth, providerLimiter, async (req, res) => {
    if (process.env.MAPS_ENABLED !== "true") throw new HttpError(503, "Maps are not enabled.");
    const { origin, destination } = req.body || {};
    if (!origin || !destination) throw new HttpError(400, "Origin and destination coordinates are required.");
    const start = {
      lat: validCoordinate(origin.lat, -90, 90, "Origin latitude"),
      lng: validCoordinate(origin.lng, -180, 180, "Origin longitude")
    };
    const end = {
      lat: validCoordinate(destination.lat, -90, 90, "Destination latitude"),
      lng: validCoordinate(destination.lng, -180, 180, "Destination longitude")
    };
    res.json(await providers.getDirections(start, end));
  });

  app.post("/api/admin/deliveries", requireAuth, requireRole("admin"), async (req, res) => {
    const { customerId, agentId, pickup, destination } = req.body || {};
    const customer = await db.prepare("SELECT id FROM users WHERE id = ?").get(customerId);
    const agent = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'delivery_agent'").get(agentId);
    if (!customer || !agent || !pickup || !destination) {
      throw new HttpError(400, "Provide an existing customer, delivery agent, and pickup/destination coordinates.");
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.transaction(async () => {
      await db.prepare(`
        INSERT INTO deliveries (id, customer_id, agent_id, status, pickup_lat, pickup_lng, destination_lat, destination_lng, created_at)
        VALUES (?, ?, ?, 'assigned', ?, ?, ?, ?, ?)
      `).run(
        id, customerId, agentId,
        validCoordinate(pickup.lat, -90, 90, "Pickup latitude"),
        validCoordinate(pickup.lng, -180, 180, "Pickup longitude"),
        validCoordinate(destination.lat, -90, 90, "Destination latitude"),
        validCoordinate(destination.lng, -180, 180, "Destination longitude"),
        now
      );
      await audit(db, req.auth.user.id, "delivery.assign", "delivery", id, { agentId, customerId });
      await addNotification(db, customerId, "Delivery assigned", "A delivery agent has been assigned to your delivery.");
      await addNotification(db, agentId, "New delivery assignment", "A delivery has been assigned to you.");
    })();
    res.status(201).json({ id, status: "assigned" });
  });

  app.post("/api/deliveries/:id/location", requireAuth, requireRole("delivery_agent"), gpsLimiter, async (req, res) => {
    const latitude = validCoordinate(req.body && req.body.latitude, -90, 90, "Latitude");
    const longitude = validCoordinate(req.body && req.body.longitude, -180, 180, "Longitude");
    const result = await db.prepare(`
      UPDATE deliveries SET current_lat = ?, current_lng = ?, location_recorded_at = ?
      WHERE id = ? AND agent_id = ? AND status IN ('assigned', 'picked_up', 'in_transit')
    `).run(latitude, longitude, new Date().toISOString(), req.params.id, req.auth.user.id);
    if (!result.changes) throw new HttpError(404, "Active delivery not found.");
    res.status(204).end();
  });

  app.get("/api/deliveries/:id/location", requireAuth, async (req, res) => {
    const delivery = await db.prepare(`
      SELECT id, customer_id, agent_id, status, current_lat, current_lng, location_recorded_at, destination_lat, destination_lng
      FROM deliveries WHERE id = ?
    `).get(req.params.id);
    if (!delivery || ![delivery.customer_id, delivery.agent_id].includes(req.auth.user.id) && req.auth.user.role !== "admin") {
      throw new HttpError(404, "Delivery not found.");
    }
    res.set("Cache-Control", "no-store");
    res.json({
      id: delivery.id,
      status: delivery.status,
      current: delivery.current_lat === null ? null : {
        latitude: delivery.current_lat,
        longitude: delivery.current_lng,
        recordedAt: delivery.location_recorded_at
      },
      destination: delivery.destination_lat === null ? null : {
        latitude: delivery.destination_lat,
        longitude: delivery.destination_lng
      }
    });
  });

  app.patch("/api/deliveries/:id/status", requireAuth, requireRole("delivery_agent"), async (req, res) => {
    const status = req.body && req.body.status;
    if (!["picked_up", "in_transit", "delivered"].includes(status)) {
      throw new HttpError(400, "Invalid delivery status.");
    }
    const now = new Date().toISOString();
    const deliveredAt = status === "delivered" ? now : null;
    const purgeAt = status === "delivered" ? retentionDate("GPS_RETENTION_DAYS", 7) : null;
    await db.transaction(async () => {
      const result = await db.prepare(`
        UPDATE deliveries SET status = ?, delivered_at = COALESCE(?, delivered_at),
          purge_location_at = COALESCE(?, purge_location_at)
        WHERE id = ? AND agent_id = ? AND (
          (status = 'assigned' AND ? = 'picked_up') OR
          (status = 'picked_up' AND ? = 'in_transit') OR
          (status = 'in_transit' AND ? = 'delivered')
        )
      `).run(status, deliveredAt, purgeAt, req.params.id, req.auth.user.id, status, status, status);
      if (!result.changes) throw new HttpError(404, "Active delivery not found.");
      const delivery = await db.prepare("SELECT customer_id FROM deliveries WHERE id = ?").get(req.params.id);
      await audit(db, req.auth.user.id, "delivery.status", "delivery", req.params.id, { status });
      await addNotification(db, delivery.customer_id, "Delivery status updated", `Your delivery status is now ${status.replace("_", " ")}.`);
    })();
    res.json({ id: req.params.id, status, purgeLocationAt: purgeAt });
  });

  app.patch("/api/admin/deliveries/:id/cancel", requireAuth, requireRole("admin"), async (req, res) => {
    const purgeAt = retentionDate("GPS_RETENTION_DAYS", 7);
    await db.transaction(async () => {
      const result = await db.prepare(`
        UPDATE deliveries SET status = 'cancelled', purge_location_at = ?
        WHERE id = ? AND status IN ('assigned', 'picked_up', 'in_transit')
      `).run(purgeAt, req.params.id);
      if (!result.changes) throw new HttpError(404, "Active delivery not found.");
      const delivery = await db.prepare("SELECT customer_id, agent_id FROM deliveries WHERE id = ?").get(req.params.id);
      await audit(db, req.auth.user.id, "delivery.cancel", "delivery", req.params.id, {});
      await addNotification(db, delivery.customer_id, "Delivery cancelled", "Your delivery was cancelled. Contact support if you need help.");
      await addNotification(db, delivery.agent_id, "Delivery cancelled", "The assigned delivery was cancelled.");
    })();
    res.json({ id: req.params.id, status: "cancelled", purgeLocationAt: purgeAt });
  });

  app.post("/api/support/ai", requireAuth, aiLimiter, async (req, res) => {
    if (process.env.AI_SUPPORT_ENABLED !== "true") throw new HttpError(503, "AI support is not enabled.");
    const message = req.body && req.body.message;
    if (typeof message !== "string" || !message.trim() || message.length > 2000) {
      throw new HttpError(400, "Message must be a non-empty string of at most 2,000 characters.");
    }
    if (req.body.consent !== true) {
      throw new HttpError(400, "Consent to sending this redacted message to the external AI provider is required.");
    }
    const answer = await providers.answerSupportQuestion(message.trim());
    res.json({ answer, stored: false, redactedSensitivePatterns: true });
  });

  app.get("/api/admin/audit-log", requireAuth, requireRole("admin"), async (req, res) => {
    const rows = await db.prepare(`
      SELECT id, actor_id AS actorId, action, target_type AS targetType, target_id AS targetId,
        details, created_at AS createdAt
      FROM admin_audit_log ORDER BY created_at DESC LIMIT 200
    `).all();
    res.json({ events: rows.map((row) => ({ ...row, details: JSON.parse(row.details) })) });
  });
}

async function audit(db, actorId, action, targetType, targetId, details) {
await db.prepare(`
    INSERT INTO admin_audit_log (id, actor_id, action, target_type, target_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), actorId, action, targetType, targetId, JSON.stringify(details), new Date().toISOString());
}

async function addNotification(db, userId, subject, body) {
  const now = new Date().toISOString();
  const user = await db.prepare(`
    SELECT email_notifications_enabled, sms_notifications_enabled, email_verified_at, phone_verified_at
    FROM users WHERE id = ?
  `).get(userId);
  const insert = db.prepare(`
    INSERT INTO notifications (id, user_id, channel, subject, body, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  await insert.run(crypto.randomUUID(), userId, "in_app", subject, body, "sent", now);
  if (user.email_notifications_enabled && user.email_verified_at) {
    await insert.run(crypto.randomUUID(), userId, "email", subject, body, "queued", now);
  }
  if (user.sms_notifications_enabled && user.phone_verified_at) {
    await insert.run(crypto.randomUUID(), userId, "sms", subject, body, "queued", now);
  }
}

module.exports = { registerIntegrationRoutes, audit };
