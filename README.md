# ZimConnect

A responsive front-end prototype and starter authentication/profile backend for the ZimConnect digital business ecosystem.

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

## Run

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open `http://127.0.0.1:3000`. The server also serves the frontend on the same origin. Set `PORT`, `HOST`, or `DATABASE_PATH` to override the defaults. The SQLite database is created at `backend/data/zimconnect.sqlite`.

Run the backend tests with `npm test`.

## Authentication and profile API

- `POST /api/auth/register` — create a consumer account (`fullName`, `email`, `password`; optional `phone`, `location`)
- `POST /api/auth/login` — authenticate with `email` and `password`
- `POST /api/auth/logout` — revoke the current session
- `GET /api/auth/me` — return the authenticated profile
- `PATCH /api/profile` — update `fullName`, `phone`, and/or `location`
- `GET /api/health` — check server and database availability

Register and login return a bearer token and expiry timestamp. Send the token in an `Authorization: Bearer <token>` header for protected routes. Passwords are scrypt-hashed and only token digests are stored in SQLite. Public registration always creates a consumer account; account roles cannot be changed through the profile API.

## Important
This is an early backend foundation, not a production-ready commerce platform. Payment gateways, identity-document verification, maps/live GPS, video storage, notifications, AI support, email/phone verification, role administration, backups, and production security review are not implemented.

Do not submit or store National ID documents or numbers through this API. Sensitive identity data requires a separately designed, encrypted, access-controlled verification workflow.
