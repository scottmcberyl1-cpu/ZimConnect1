const { deletePrivateObject } = require("./providers");

async function purgeExpiredData(db, services = { deletePrivateObject }) {
  const now = new Date().toISOString();
  const documents = db.prepare(`
    SELECT id, object_key FROM identity_documents
    WHERE delete_after <= ? OR (status = 'upload_pending' AND created_at <= ?)
  `).all(now, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  for (const document of documents) {
    await services.deletePrivateObject(document.object_key);
    db.prepare("DELETE FROM identity_documents WHERE id = ?").run(document.id);
  }

  const videos = db.prepare(`
    SELECT id, object_key FROM videos
    WHERE delete_after <= ? OR (status = 'upload_pending' AND created_at <= ?)
  `).all(now, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  for (const video of videos) {
    await services.deletePrivateObject(video.object_key);
    db.prepare("DELETE FROM videos WHERE id = ?").run(video.id);
  }

  const locations = db.prepare(`
    UPDATE deliveries SET current_lat = NULL, current_lng = NULL, location_recorded_at = NULL,
      pickup_lat = NULL, pickup_lng = NULL, destination_lat = NULL, destination_lng = NULL,
      purge_location_at = NULL
    WHERE purge_location_at <= ?
  `).run(now);
  const expiredSessions = db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now).changes;
  const expiredEmailTokens = db.prepare("DELETE FROM email_verification_tokens WHERE expires_at <= ?").run(now).changes;
  const expiredPhoneCodes = db.prepare("DELETE FROM phone_verification_codes WHERE expires_at <= ?").run(now).changes;
  const oldNotifications = db.prepare("DELETE FROM notifications WHERE created_at <= ?")
    .run(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()).changes;
  return {
    documents: documents.length,
    videos: videos.length,
    locations: locations.changes,
    expiredSessions,
    expiredEmailTokens,
    expiredPhoneCodes,
    oldNotifications
  };
}

module.exports = { purgeExpiredData };
