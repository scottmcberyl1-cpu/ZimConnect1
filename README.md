# ZimConnect

A responsive frontend prototype and backend API foundation for the ZimConnect digital business ecosystem.

## Included
- Consumer home and marketplace
- Business registration + strong owner verification UI
- Supplier / B2B wholesale marketplace
- Bulk pricing and bulk orders
- Business advertising with image/video concept
- External shareable business links and QR-code concept
- ZimConnect Business Academy
- Business opportunities with startup capital, requirements and projections
- Consumer orders and delivery tracking
- Payment-ready checkout architecture concept
- Business dashboard
- Supplier dashboard
- Customer support / AI assistant concept
- Admin control centre
- Responsive desktop/mobile navigation

## Run locally

Requires Node.js 20 or newer. To exercise every provider-backed feature, configure a private S3-compatible bucket, a reachable ClamAV daemon, and email/SMS/provider credentials.

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Fill in `.env` for the providers you want to exercise. Open `http://127.0.0.1:3000`; the server also serves the frontend on the same origin. Set `PORT`, `HOST`, or `DATABASE_PATH` to override defaults. The SQLite database is created at `backend/data/zimconnect.sqlite`.

Generate a backup key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and keep it outside the repository and backup directory. Run tests with `npm test`.

## Implemented backend APIs

### Accounts and administration

- `POST /api/auth/register` — create a consumer account (`fullName`, `email`, `password`, required E.164 `phone`; optional `location`)
- `GET /api/auth/verify-email` — open a confirmation page; `POST /api/auth/verify-email` commits the verification so link-scanners don't consume tokens
- `POST /api/auth/verify-phone` — verify the SMS code; both channels are required before sign-in
- `POST /api/auth/resend-verification` — resend outstanding verification instructions
- `POST /api/auth/login` — authenticate with `email` and `password` after both verifications
- `POST /api/auth/logout` — revoke the current session
- `GET /api/auth/me` — return the authenticated profile
- `PATCH /api/profile` — update `fullName`, `phone`, and/or `location`
- `GET/PATCH /api/profile/notification-preferences` — opt in or out of transactional email/SMS notifications
- `GET /api/admin/users` and `PATCH /api/admin/users/:id/role` — administrator-only role management
- `GET /api/admin/audit-log` — review role and moderation changes
- `GET /api/health` — check server and database availability

Registration requires an E.164 phone number. After both verification challenges succeed, the phone verification response returns a bearer token and expiry. Send it in an `Authorization: Bearer <token>` header for protected routes. Passwords use scrypt, sessions store token digests, and public registration always creates a consumer. The profile API cannot set roles. Bootstrap the first administrator only after account verification with `npm run admin:promote -- verified-user@example.com`.

### Payments, delivery, media, and support

- `POST /api/payments/intents`, `GET /api/payments/:id`, `POST /api/payments/:id/sandbox/complete` — explicitly simulated USD payments; sandbox completion is disabled in production and no real funds move.
- `POST /api/identity/documents` and `/complete`, `GET /api/identity/documents`, `DELETE /api/identity/documents/:id` — private, short-lived S3 upload URLs, file-size/type checks, ClamAV scanning, and manual admin review.
- `POST /api/videos/upload-url` and `/complete`, `GET /api/videos`, `GET /api/videos/:id/download` — private S3 video upload and moderated download.
- `POST /api/maps/directions` — Google Routes API.
- `POST /api/admin/deliveries`, `POST /api/deliveries/:id/location`, `PATCH /api/deliveries/:id/status`, `GET /api/deliveries/:id/location` — assigned-agent GPS updates and customer polling. Only the latest GPS point is stored; updates are limited to 30/minute per agent.
- `GET /api/notifications`, `PATCH /api/notifications/:id/read`, `POST /api/notifications/:id/retry` — in-app notifications and opted-in transactional email/SMS, with bounded retries.
- `POST /api/support/ai` — OpenAI support answers; common phone, email, and Zimbabwe ID patterns are redacted and prompts are not stored by this API.

Uploads require the signed headers returned with the URL. Configure S3 Block Public Access, private bucket policies, a lifecycle rule for stale `identity-staging/` and `video-staging/` objects, and bucket CORS for your exact application origin, `PUT`, `Content-Type`, and `x-amz-server-side-encryption`. Files upload to a short-lived staging key, are checked and scanned, then copied to a server-only key with an ETag precondition before moderation; clients cannot overwrite an accepted object. Keep ClamAV reachable only on a private network and configure `StreamMaxLength` to at least 100 MB; file completion fails closed until scanning succeeds. Google Maps, OpenAI, SMTP, Africa's Talking, and AWS credentials are server-side only.

### Backups and retention

`npm run backup` creates an AES-256-GCM encrypted SQLite backup under `backend/backups`; the server also makes an initial backup and repeats every 24 hours when `BACKUP_ENCRYPTION_KEY` is configured. `npm run restore-backup -- backend/backups/zimconnect-<timestamp>.enc` verifies the backup before restore and creates an encrypted backup of the current database first. Stop the server before restore. Losing the 32-byte backup key makes backups unrecoverable.

The retention worker deletes expired identity/video objects, purges pickup, destination, and latest-driver coordinates, and removes expired auth challenges and old notifications. Defaults are 30 days for identity/video and 7 days for GPS; set exact periods only after confirming applicable legal and dispute requirements. Encrypted database backups can retain deleted database records for up to `BACKUP_RETENTION_DAYS` longer; include backup copies in the approved retention policy. Backups are local only and must be placed on durable, access-controlled storage; this does not protect against host loss.

## Production limitations and security

Production startup requires provider credentials, HTTPS `PUBLIC_BASE_URL`, an explicit proxy-hop count, a 32-byte backup key, and retention periods. Set `HOST` for the deployment (commonly `0.0.0.0` behind a correctly configured TLS reverse proxy). The app does not enable CORS or trust forwarded client IPs unless configured.

Real payment processing is deliberately **not implemented** (sandbox only). SQLite is suitable only for a single application instance with a durable local volume. The existing frontend remains a visual prototype and is not wired to these APIs. Email/SMS verification UI, full order management, malware scanning operations, identity-verification legal policy, provider account setup, S3 bucket policy/CORS, off-site backups, operational monitoring, and an independent pre-deployment security assessment remain deployment work. The AI PII filters cover common formats only and are not a guarantee of anonymization; disclose external processing and obtain appropriate user consent before production use.

Do not submit National ID numbers as profile text. Identity documents are sensitive personal data: keep the S3 bucket private, restrict administrator access, and confirm lawful collection and retention before enabling uploads in production.
