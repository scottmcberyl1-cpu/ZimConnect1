async function dispatchQueuedNotifications(db, services) {
  const now = new Date();
  const queued = db.prepare(`
    SELECT n.id, n.user_id, n.channel, n.subject, n.body, n.attempts,
      u.email, u.phone, u.email_notifications_enabled, u.sms_notifications_enabled,
      u.email_verified_at, u.phone_verified_at
    FROM notifications n JOIN users u ON u.id = n.user_id
    WHERE n.status = 'queued' AND (n.next_attempt_at IS NULL OR n.next_attempt_at <= ?)
      AND n.channel IN ('email', 'sms')
    ORDER BY n.created_at ASC LIMIT 25
  `).all(now.toISOString());

  for (const notification of queued) {
    const optedIn = notification.channel === "email"
      ? notification.email_notifications_enabled && notification.email_verified_at
      : notification.sms_notifications_enabled && notification.phone_verified_at;
    if (!optedIn) {
      db.prepare("UPDATE notifications SET status = 'failed', last_error = 'Channel not verified or opted in' WHERE id = ?")
        .run(notification.id);
      continue;
    }

    try {
      if (notification.channel === "email") {
        await services.sendEmail({
          to: notification.email,
          subject: notification.subject,
          text: notification.body
        });
      } else {
        await services.sendSms({ to: notification.phone, message: `${notification.subject}: ${notification.body}` });
      }
      db.prepare("UPDATE notifications SET status = 'sent', next_attempt_at = NULL, last_error = NULL WHERE id = ?")
        .run(notification.id);
    } catch (error) {
      const attempts = notification.attempts + 1;
      const failed = attempts >= 5;
      const retryAt = failed ? null : new Date(now.getTime() + 60 * 1000 * (2 ** (attempts - 1))).toISOString();
      db.prepare(`
        UPDATE notifications SET attempts = ?, status = ?, next_attempt_at = ?,
          last_error = 'Provider delivery failed' WHERE id = ?
      `).run(attempts, failed ? "failed" : "queued", retryAt, notification.id);
      console.error(`Notification delivery failed for ${notification.id}.`);
    }
  }
}

module.exports = { dispatchQueuedNotifications };
