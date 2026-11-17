# ZimConnect

A responsive frontend prototype and backend API for the ZimConnect digital business ecosystem. The backend supports SQLite for local development and PostgreSQL for production.

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

Fill in `.env` for the providers you want to exercise. Open `http://127.0.0.1:3000`; the server also serves the frontend on the same origin. Set `PORT`, `HOST`, or `DATABASE_PATH` to override defaults. The SQLite database is created at `backend/data/zimconnect.sqlite`. Provider-backed features remain disabled until enabled and configured; email and SMS delivery are needed to complete registration and sign-in.

Run tests with `npm test`. For local encrypted backups, generate a 32-byte key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and keep it outside the repository and backup directory.

## Container image

Build with `docker build -t zimconnect .`. The image runs as the non-root Node user and includes PostgreSQL client tools required by encrypted database backup and restore. Supply production settings through the deployment platform's secret/environment configuration; do not copy `.env` or database/backup files into the image.

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

### Commerce, delivery, media, and support

- `GET/POST /api/products`, `PATCH /api/products/:id` — browse and manage seller products.
- `POST /api/orders`, `GET /api/orders`, `GET /api/orders/:id`, `PATCH /api/orders/:id/status` — create stock-reserving orders, inspect order history, and progress fulfillment.
- `GET /api/payments/:id` — inspect an order payment. In development, `POST /api/payments/:id/sandbox/complete` simulates a payment; it is disabled in production.
- With `PAYNOW_ENABLED=true`, order checkout starts Paynow and returns a hosted checkout URL. `/api/payments/paynow/result` verifies the signed callback and polls Paynow before changing payment state. Configure an approved merchant account before enabling live checkout.
- `POST /api/identity/documents` and `/complete`, `GET /api/identity/documents`, `DELETE /api/identity/documents/:id` — private, short-lived S3 upload URLs, file-size/type checks, ClamAV scanning, and manual admin review. Upload requests must include `legalConsent: true`; the active policy URL/version is recorded.
- `POST /api/videos/upload-url` and `/complete`, `GET /api/videos`, `GET /api/videos/:id/download` — private S3 video upload and moderated download.
- `POST /api/maps/directions` — Google Routes API.
- `POST /api/admin/deliveries`, `POST /api/deliveries/:id/location`, `PATCH /api/deliveries/:id/status`, `GET /api/deliveries/:id/location` — assigned-agent GPS updates and customer polling. Only the latest GPS point is stored; updates are limited to 30/minute per agent.
- `GET /api/notifications`, `PATCH /api/notifications/:id/read`, `POST /api/notifications/:id/retry` — in-app notifications and opted-in transactional email/SMS, with bounded retries.
- `POST /api/support/ai` — OpenAI support answers; requests must include `consent: true`. Common phone, email, and Zimbabwe ID patterns are redacted and prompts are not stored by this API.

Uploads require the signed headers returned with the URL. Configure S3 Block Public Access, private bucket policies, a lifecycle rule for stale `identity-staging/` and `video-staging/` objects, and bucket CORS for your exact application origin, `PUT`, `Content-Type`, and `x-amz-server-side-encryption`. Files upload to a short-lived staging key, are checked and scanned, then copied to a server-only key with an ETag precondition before moderation; clients cannot overwrite an accepted object. Keep ClamAV reachable only on a private network and configure `StreamMaxLength` to at least 100 MB; file completion fails closed until scanning succeeds. Google Maps, OpenAI, SMTP, Africa's Talking, and AWS credentials are server-side only.

### PostgreSQL migration, backups, and retention

To copy an existing SQLite database into PostgreSQL, stop the application and set `DATABASE_PATH` to the source file and `DATABASE_URL` to the destination, then run `npm run migrate:postgres`. It copies shared schema columns and skips rows that conflict with destination keys; inspect the reported row counts and verify the destination before switching production traffic. The command does not delete or modify the SQLite source.

`npm run backup` creates an AES-256-GCM encrypted backup under `backend/backups`. Local development may use `BACKUP_ENCRYPTION_KEY`; production uses an AWS KMS data key (`BACKUP_KMS_KEY_ID`) and uploads encrypted files to `BACKUP_S3_BUCKET`. The server makes an initial backup and repeats every 24 hours. PostgreSQL backup/restore requires `pg_dump` and `pg_restore` in the deployment image. `npm run restore-backup -- backend/backups/zimconnect-<timestamp>.enc` validates a PostgreSQL dump before restoring and creates a backup of the current database first. Stop application traffic before restoring.

The retention worker deletes expired identity/video objects, purges pickup, destination, and latest-driver coordinates, and removes expired auth challenges and old notifications. Configure `IDENTITY_RETENTION_DAYS`, `VIDEO_RETENTION_DAYS`, `GPS_RETENTION_DAYS`, and `BACKUP_RETENTION_DAYS` after confirming applicable legal and dispute requirements. Encrypted database backups can retain deleted database records longer; include backup copies in the approved retention policy.

## Production limitations and security

Production startup requires PostgreSQL `DATABASE_URL`, HTTPS `PUBLIC_BASE_URL`, explicit HTTPS `CORS_ORIGINS`, `TRUST_PROXY_HOPS`, AWS region/S3 backup bucket/KMS key settings, and explicit retention periods. Provider credentials are required when their feature is enabled. Set `HOST` for the deployment (commonly `0.0.0.0`) behind a correctly configured TLS reverse proxy; set the proxy-hop count to match the trusted deployment topology. SQLite is intended for local development or a single application instance with a durable volume.

The frontend remains a visual prototype and is not wired to the APIs. Before production, configure and test provider accounts, the TLS reverse proxy, PostgreSQL and `pg_dump`/`pg_restore`, private S3 bucket policies/CORS/lifecycle, least-privilege AWS IAM/KMS access, ClamAV operations, off-site restore procedures, monitoring/alerts, and applicable identity-verification policies. Paynow live payment behavior must be validated with the merchant account. An independent pre-deployment security assessment is still recommended. AI redaction covers common formats only and does not guarantee anonymization; disclose external processing and obtain user consent.

Do not submit National ID numbers as profile text. Identity documents are sensitive personal data: keep the S3 bucket private, restrict administrator access, and confirm lawful collection and retention before enabling uploads in production.
