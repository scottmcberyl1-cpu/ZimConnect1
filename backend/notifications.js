async function dispatchQueuedNotifications(db, services) {
  const now = new Date();
  const claimNotifications = async () => {
    let queued = await db.prepare(`
    SELECT n.id, n.user_id, n.channel, n.subject, n.body, n.attempts,
      u.email, u.phone, u.email_notifications_enabled, u.sms_notifications_enabled,
      u.email_verified_at, u.phone_verified_at
    FROM notifications n JOIN users u ON u.id = n.user_id
    WHERE n.status = 'queued' AND (n.next_attempt_at IS NULL OR n.next_attempt_at <= ?)
      AND (n.locked_until IS NULL OR n.locked_until <= ?)
      AND n.channel IN ('email', 'sms')
    ORDER BY n.created_at ASC LIMIT 25
    ${db.isPostgres ? "FOR UPDATE OF n SKIP LOCKED" : ""}
  `).all(now.toISOString(), now.toISOString());
    if (queued.length) {
      const lockUntil = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
      for (const notification of queued) {
        await db.prepare(`
          UPDATE notifications SET locked_until = ?
          WHERE id = ? AND status = 'queued'
        `).run(lockUntil, notification.id);
      }
    }
    return queued;
  };
  const queued = db.isPostgres
    ? await db.transaction(claimNotifications)()
    : await claimNotifications();

  for (const notification of queued) {
    const optedIn = notification.channel === "email"
      ? notification.email_notifications_enabled && notification.email_verified_at
      : notification.sms_notifications_enabled && notification.phone_verified_at;
    if (!optedIn) {
      await db.prepare("UPDATE notifications SET status = 'failed', locked_until = NULL, last_error = 'Channel not verified or opted in' WHERE id = ?")
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
      await db.prepare("UPDATE notifications SET status = 'sent', locked_until = NULL, next_attempt_at = NULL, last_error = NULL WHERE id = ?")
        .run(notification.id);
    } catch (error) {
      const attempts = notification.attempts + 1;
      const failed = attempts >= 5;
      const retryAt = failed ? null : new Date(now.getTime() + 60 * 1000 * (2 ** (attempts - 1))).toISOString();
      await db.prepare(`
        UPDATE notifications SET attempts = ?, status = ?, next_attempt_at = ?,
          locked_until = NULL, last_error = 'Provider delivery failed' WHERE id = ?
      `).run(attempts, failed ? "failed" : "queued", retryAt, notification.id);
      console.error(`Notification delivery failed for ${notification.id}.`);
    }
  }
}

module.exports = { dispatchQueuedNotifications };
