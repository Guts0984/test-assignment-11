# Courier delivery

City delivery service: senders create deliveries, dispatchers hand them to couriers, couriers work from a
phone (often offline), recipients follow a tracking link and tell the courier a code.

> This README grows block by block. Sections marked _(planned)_ are filled in by later commits.

## Repository layout

| Path               | What                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| `apps/api`         | NestJS business API _(planned)_                                               |
| `apps/web`         | Next.js app: sender cabinet, dispatcher, tracking, `/courier` PWA _(planned)_ |
| `apps/sender-stub` | Webhook receiver used in compose and e2e _(planned)_                          |
| `packages/shared`  | Zod schemas, status machine, tariff and money rules, time helpers             |
| `supabase/`        | Config, migrations, RLS, seed _(planned)_                                     |

## Development

```bash
pnpm install
cp .env.example .env
pnpm build            # builds packages/shared and packages/db (others depend on their dist)
pnpm typecheck
pnpm lint
pnpm test             # unit tests, no services needed
pnpm supabase start   # local Postgres + Auth + Realtime + Storage; applies migrations and the seed
pnpm test:db          # database tests, need the running Supabase stack
pnpm db:reset         # rebuild the database from migrations + seed (about a minute, the seed is 50 000 rows)
```

Code rules, enforced by ESLint: no `any`, no `@ts-ignore` without a written reason, and no classes outside
NestJS building blocks.

## Database (Supabase)

`pnpm supabase start` runs the stack with only the services this project needs (Postgres 17, Auth, REST,
Realtime, Storage; Studio, mail, analytics, edge runtime and the S3 protocol are disabled in
`supabase/config.toml`). Migrations in `supabase/migrations` and `supabase/seed.sql` are applied automatically.
The local demo keys in `.env.example` are the public defaults of the Supabase CLI. They are not secrets and
must never be reused outside a development machine.

Auth settings that matter: self sign-up is **disabled** (users come from the seed or the admin API),
passwords need 8+ characters, and the sign-in rate limit is raised to 300 per 5 minutes per IP so that the
test suite can log in many users. Production should use Supabase's defaults.

### Demo logins (all created by the seed)

| Role       | Emails                                               | Password              |
| ---------- | ---------------------------------------------------- | --------------------- |
| Sender     | `sender1@example.com` … `sender3@example.com`        | `Sender-Pass-123`     |
| Dispatcher | `dispatcher1@example.com`, `dispatcher2@example.com` | `Dispatcher-Pass-123` |
| Courier    | `courier01@example.com` … `courier30@example.com`    | `Courier-Pass-123`    |

### Seed

3 senders, 2 dispatchers, 30 couriers and **50 000 deliveries over the last 90 days**: 44 500 delivered,
3 000 cancelled, 1 500 returned, 400 created, 300 waiting for a retry, 120 returning, 110 assigned, 70 picked
up. Numbers are `DLV-000001` … `DLV-050000` without gaps. It also contains about 220 000 history events,
a shift per courier per day (24 of 30 couriers are on shift today), cash figures for every closed shift with
about 10 % of shifts handing in a different amount, five deliveries with a blocked handover, and 115 000
already-delivered notifications. The generator is deterministic (hash based) and is checked by
`packages/db/tests/seed.test.ts` (valid history chains, cash adds up, no courier above 8 active, ...).
Seeded _assigned_ deliveries are younger than 45 minutes, so the background job releases them if nobody picks
them up, which is the correct behaviour.

### What the database enforces itself

`apps/api` takes row locks and checks rules first so it can give good errors; the database refuses to
store an illegal state even if the API has a bug.

| Rule                                                                                                                         | Mechanism                                                                                                                                              | SQLSTATE |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Status transitions                                                                                                           | `deliveries_before_update` trigger, same table as in the status section                                                                                | `DL001`  |
| At most 8 active deliveries per courier, also under concurrency                                                              | the trigger locks the courier row, then counts                                                                                                         | `DL002`  |
| Assignment needs an open shift                                                                                               | same trigger                                                                                                                                           | `DL003`  |
| Immutable columns (number, sender, price inputs, address, ...)                                                               | same trigger                                                                                                                                           | `DL004`  |
| Deliveries are created as `created`                                                                                          | `deliveries_before_insert`                                                                                                                             | `DL005`  |
| Gapless numbers `DLV-…`                                                                                                      | counter row updated inside the creating transaction; a rollback gives the number back. Callers cannot supply a number                                  | –        |
| One active assignment per delivery                                                                                           | partial unique index on `assignments(delivery_id) where ended_at is null`                                                                              | `23505`  |
| One open shift per courier                                                                                                   | partial unique index                                                                                                                                   | `23505`  |
| Prices                                                                                                                       | CHECK constraints compare fee and commission with SQL copies of the tariff (a test proves SQL equals `@courier/shared` for 4 000 random inputs)        | `23514`  |
| Courier attached exactly while `assigned`/`picked_up`/`delivered`; delivered needs the collected sum to equal the COD amount | CHECK constraints                                                                                                                                      | `23514`  |
| Handover blocked only with 5 wrong codes; never more than 5                                                                  | CHECK constraints                                                                                                                                      | `23514`  |
| Sender notifications                                                                                                         | `delivery_events` trigger writes the outbox row in the same transaction, numbered per delivery                                                         | –        |
| 45-minute pickup timeout                                                                                                     | `app_private.release_stale_assignments(p_now)` called by `pg_cron` every minute; `FOR UPDATE SKIP LOCKED`; takes a clock argument so tests never sleep | –        |

### Row Level Security (every table has RLS enabled)

`anon` and `authenticated` have **no write privilege on any table**: all writes go through `apps/api`.
`authenticated` can only `SELECT`, narrowed by these policies. The role is read from `app_metadata.role`,
which only the service role can change (editing `user_metadata` does nothing; a test tries it).

| Table                                                           | sender            | courier                                                                            | dispatcher | anon |
| --------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------- | ---------- | ---- |
| `deliveries`                                                    | own (`sender_id`) | assigned to them (`courier_id`)                                                    | all        | none |
| `delivery_events`                                               | of own deliveries | of their deliveries                                                                | all        | none |
| `assignments`                                                   | none              | own, including ended ones (this is how a courier learns a delivery was taken away) | all        | none |
| `courier_actions`                                               | none              | own (including rejections and reasons)                                             | all        | none |
| `photos` (metadata)                                             | of own deliveries | own                                                                                | all        | none |
| `shifts`                                                        | none              | own                                                                                | all        | none |
| `cash_adjustments`                                              | none              | none                                                                               | all        | none |
| `notifications`, `notification_attempts`                        | own               | none                                                                               | none       | none |
| `sender_webhooks` (signing secret)                              | own               | none                                                                               | none       | none |
| `profiles`, `couriers`, `senders`                               | own row           | own row                                                                            | all        | none |
| `delivery_secrets` (recipient code, tracking token and channel) | none              | none                                                                               | none       | none |
| `idempotency_keys`, `delivery_number_counter`                   | none              | none                                                                               | none       | none |

Tracking reads go through the API, which reads `delivery_secrets` with the server connection.
Storage: bucket `delivery-photos` is private (5 MB, jpeg/png/webp). Browsers have no insert/update/delete
policy. `storage.objects` has one `SELECT` policy (dispatchers, and senders for photos of their own deliveries) so
signed URLs can only be created by them; paths are `<delivery id>/<photo id>.<ext>`.

Internal functions live in the `app_private` schema, which PostgREST does not expose, and `EXECUTE` is
revoked from everyone but the owner.

### Realtime

- `deliveries`, `assignments`, `shifts` and `courier_actions` are in the `supabase_realtime` publication, so
  Realtime applies the policies above to each subscriber.
- Tracking uses **Broadcast** on a private-by-obscurity channel `tracking:<tracking_channel>` (128 random bits,
  separate from the URL token). A trigger sends only `number, status, attemptNo, courierName ("Olena K."),
amountDueKop, updatedAt`. No address, phone or code. Anonymous clients get nothing from `postgres_changes`.
- Findings worth knowing (both covered by tests):
  - an anonymous `postgres_changes` subscription receives an empty error stub (`new: {}`, "401 Unauthorized") for
    each change, never data;
  - supabase-js joins a client's second and later channels with the **anon key** instead of the user's token.
    Use one client (or one channel) per authenticated subscription.

### Indexes

| Index                                                                                                                  | Serves                                             |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `deliveries(number)` unique                                                                                            | number lookup, gapless numbering backstop          |
| `deliveries(sender_id, created_at desc, id)`                                                                           | sender list, newest first, keyset/offset paging    |
| `deliveries(sender_id, status, created_at desc)`                                                                       | sender list filtered by status                     |
| `deliveries(sender_id, recipient_phone)`                                                                               | sender search by phone (exact and prefix)          |
| `deliveries(zone, created_at) where status in ('created','failed_attempt')`                                            | dispatcher queue per zone (tiny partial index)     |
| `deliveries(courier_id) where status in ('assigned','picked_up')`                                                      | courier load `n/8`, courier work list, limit check |
| `deliveries(courier_id, delivered_at desc) where status = 'delivered'`                                                 | courier history                                    |
| `deliveries(assigned_at) where status = 'assigned'`                                                                    | 45-minute timeout scan                             |
| `deliveries(delivered_at) where status = 'delivered'`, `deliveries(created_at)`, `deliveries(status, created_at desc)` | reports and board filters                          |
| `deliveries(delivered_shift_id)`                                                                                       | cash totals per shift                              |
| `assignments(delivery_id) where ended_at is null` unique                                                               | one courier per delivery                           |
| `assignments(courier_id) where ended_at is null`, `(courier_id, assigned_at desc)`, `(delivery_id, assigned_at)`       | courier views, history                             |
| `delivery_events(delivery_id, id)`                                                                                     | delivery history                                   |
| `delivery_events(type, server_time)`                                                                                   | report: failed attempts by reason                  |
| `shifts(courier_id) where closed_at is null` unique                                                                    | one open shift per courier                         |
| `shifts(courier_id, opened_at desc)`, `shifts(closed_at)`                                                              | shift lists, report: discrepancies                 |
| `notifications(next_attempt_at) where status = 'pending'`                                                              | worker: what is due                                |
| `notifications(delivery_id, seq) where status = 'pending'`, unique `(delivery_id, seq)`                                | per-delivery ordering                              |
| `notifications(sender_id, created_at desc, id)`                                                                        | sender notification log                            |
| `courier_actions(courier_id, received_at desc) where result = 'rejected'`                                              | courier's rejected list                            |

Measured on the seed (p95 of 20 runs, `packages/db/tests/perf.test.ts`, budget 300 ms): board queue 1 ms,
courier load 3 ms, 90-day report 26 ms, sender list with filters 2 ms, searches 6 ms.

### Database tests (`pnpm test:db`, ~390 tests, real Supabase, one file at a time)

| File                      | What it tries to break                                                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constraints.test.ts`     | all 64 status pairs, the 9th active delivery, two concurrent assignments to a courier with 7 active (50 rounds), shift rules, immutable columns, 50 concurrent creates plus 20 rollbacks, every price/phone/weight/COD boundary, SQL tariff vs TypeScript tariff |
| `outbox-and-jobs.test.ts` | outbox order and payload, rollback leaves no notification, 10 concurrent events, the 45-minute job at 44:59 / 45:00 / 45:01, skip-locked, **a real `pg_cron` run**                                                                                               |
| `rls.test.ts`             | role × table visibility matrix against ground truth, writes refused on every table for every role, embedding tricks, forged / unsigned / tampered / expired JWTs, role escalation through `user_metadata`, sign-up                                               |
| `realtime.test.ts`        | other users' changes never arrive, courier B sees the assignment removal, tracking payload has no address / phone / code                                                                                                                                         |
| `storage.test.ts`         | who can sign which photo, path traversal, public URL, expiry, tampered token, uploads of non-images and 5 MB+ files                                                                                                                                              |
| `seed.test.ts`            | seed shape and internal consistency, all 35 demo logins really work                                                                                                                                                                                              |
| `perf.test.ts`            | board, report and list queries under 300 ms, indexes actually used                                                                                                                                                                                               |
| `schema-drift.test.ts`    | the Drizzle schema equals the live database                                                                                                                                                                                                                      |

Bugs these tests found while the block was written: a lock-upgrade **deadlock** between concurrent history
inserts (fixed with a `BEFORE INSERT` lock trigger), a misleading error when assigning without a courier,
Realtime stubs for anonymous subscribers, the Realtime second-channel token issue, and a Drizzle quirk that
breaks `sql.json()` on the client it wraps.

## API (`apps/api`)

NestJS 11 on Express, Drizzle over a direct Postgres connection (transactions and `SELECT … FOR UPDATE` live here,
not in `supabase-js`), Zod validation from `@courier/shared`. Swagger UI at **`/docs`** (`/docs-json` for the raw
document). Classes exist only for Nest building blocks (controllers, guard, filter, pipe); all business logic is
plain functions in `src/domain` (a lint rule enforces it).

```bash
pnpm --filter @courier/api dev        # or: pnpm build && pnpm --filter @courier/api start
```

`src/config/env.ts` parses every variable with Zod: secrets (`DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) have no
default and stop the boot with one readable error; everything else has a default.

### What the API does and what Supabase does

|                      | `apps/api`                                                                                                                                                                                          | Supabase                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Login                | verifies the JWT: ES256/RS256 through the project's JWKS, HS256 only if `SUPABASE_JWT_SECRET` is set; `alg` is pinned per key type, `exp`/`sub`/`iss`/`aud` required, role only from `app_metadata` | GoTrue issues tokens                                  |
| Writes               | **all of them**: create, cancel, assign, courier actions, shifts, unblock, photos                                                                                                                   | browsers cannot write (no grants)                     |
| Reads for the UI     | REST endpoints (board, lists, cards, report, tracking)                                                                                                                                              | RLS-protected `SELECT` + Realtime for live updates    |
| Photos               | validates (magic bytes, size), stores with the service role, signs URLs                                                                                                                             | private bucket, policies                              |
| Last line of defence | takes locks and gives good errors first                                                                                                                                                             | triggers and constraints refuse illegal states anyway |

### Endpoints

| Role               | Method and path                                                            | Purpose                                                                     |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| public             | `GET /health`, `GET /tracking/:token`                                      | liveness; recipient view                                                    |
| any                | `GET /me`                                                                  | who am I                                                                    |
| sender             | `POST /deliveries/quote`                                                   | price preview (server computed)                                             |
| sender             | `POST /deliveries` + `Idempotency-Key`                                     | create → `201`, replay → `200` + `Idempotent-Replay: true`                  |
| sender             | `GET /deliveries?q&status&from&to&page&pageSize`                           | own deliveries                                                              |
| sender, dispatcher | `GET /deliveries/:id`, `GET /deliveries/:id/photos`                        | card with history; signed photo URLs (`SIGNED_URL_TTL_SECONDS`)             |
| sender             | `POST /deliveries/:id/cancel`                                              | before pickup                                                               |
| dispatcher         | `GET /dispatch/board`                                                      | queue per zone, courier load `n/8`, shift state, blocked handovers          |
| dispatcher         | `GET /dispatch/deliveries`                                                 | all deliveries, same filters                                                |
| dispatcher         | `POST /dispatch/deliveries/:id/assign` `{courierId, reassign}`             | assign / explicit reassign                                                  |
| dispatcher         | `POST /dispatch/deliveries/:id/unblock`, `…/returned`                      | unblock handover; `returning → returned`                                    |
| dispatcher         | `GET /dispatch/couriers/:id/shift`, `POST …/shift/close` `{handedCashKop}` | expected cash; close with discrepancy                                       |
| dispatcher         | `GET /dispatch/report?from&to`                                             | delivered, mean assign→deliver time, failures by reason, cash discrepancies |
| courier            | `POST /courier/shift/open`, `GET /courier/today`                           | shift; today's list + deliveries taken away from them                       |
| courier            | `POST /courier/actions` `{actions: [...]}`                                 | batch of pickup / deliver / fail, each with a device-made id                |
| courier            | `GET /courier/actions/rejected`                                            | rejected actions with reasons                                               |
| courier            | `PUT /courier/photos/:photoId?deliveryId&kind`                             | raw image body, idempotent                                                  |

Errors always look like `{ "error": { "code", "message", "details?", "requestId" } }`. Validation errors carry
`details.fields` (`{"address.city": "…"}`) so forms can show them next to the field. Codes and their HTTP status
are in `packages/shared/src/errors.ts`; bad input is always 4xx. A foreign resource answers `404`, exactly like a
missing one.

### Courier actions and offline conflicts

Each action has a `clientActionId` made on the device. The API locks the delivery row, then the courier row, then
inserts the action row `ON CONFLICT DO NOTHING`: a retry (even a parallel one) finds the stored outcome and returns
it unchanged. Outcomes are `applied` or `rejected` with a code and message, stored in `courier_actions`.

| Offline action                                | Server state at sync                                                       | Result                                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| pickup                                        | assigned to me                                                             | applied                                                                                                                    |
| pickup                                        | already picked up by me                                                    | applied, no-op                                                                                                             |
| pickup                                        | released by the 45-minute job, nobody else took it                         | applied (taken back) if I have a shift and fewer than 8 deliveries, else rejected `SHIFT_CLOSED` / `COURIER_LIMIT_REACHED` |
| pickup                                        | reassigned to another courier                                              | rejected `REASSIGNED`                                                                                                      |
| pickup                                        | cancelled                                                                  | rejected `CANCELLED`                                                                                                       |
| deliver, correct code                         | assigned to me / picked up by me / back in the queue / waiting for a retry | **applied**                                                                                                                |
| deliver, correct code                         | reassigned to another courier (assigned or picked up)                      | **applied**; the other courier's assignment ends with `delivered_by_other` and they see it in `removed`                    |
| deliver, correct code                         | cancelled                                                                  | rejected `CANCELLED`                                                                                                       |
| deliver, correct code                         | already delivered by someone else                                          | rejected `INVALID_STATUS`                                                                                                  |
| deliver, correct code                         | I was never assigned this delivery                                         | rejected `NOT_YOUR_DELIVERY`                                                                                               |
| deliver                                       | handover blocked                                                           | rejected `HANDOVER_BLOCKED` (resend after the dispatcher unblocks)                                                         |
| deliver, wrong code                           | any                                                                        | rejected `WRONG_CODE`; counts towards the 5; the 5th blocks                                                                |
| deliver, wrong amount                         | any                                                                        | rejected `COD_MISMATCH` (not counted as a wrong code)                                                                      |
| deliver, photo missing or of another delivery | any                                                                        | rejected `PHOTO_REQUIRED`                                                                                                  |
| deliver                                       | my shift was closed meanwhile                                              | applied; the cash goes to `cash_adjustments` of that shift                                                                 |
| fail                                          | picked up by me                                                            | applied (`failed_attempt`, or `returning` after the 3rd)                                                                   |
| fail                                          | anything else                                                              | rejected with `REASSIGNED` / `CANCELLED` / `NOT_YOUR_DELIVERY` / `INVALID_STATUS`                                          |
| any                                           | same `clientActionId` as before                                            | the stored outcome is returned, nothing is applied again                                                                   |

The code cannot be checked offline (the device never gets it), so a wrong code shows up as a rejection after sync.

### Abuse protection (no Redis)

All in-process, single API instance (documented limit); the key is the TCP peer address.

- **Fair share before anything else:** at most `MAX_INFLIGHT_PER_IP` simultaneous requests per address (and
  `MAX_INFLIGHT_GLOBAL` in total), checked before body parsing, authentication and the DB pool. One client cannot
  hold every worker.
- **Token buckets** per IP and per user, plus stricter buckets for creation, unblock, shift close and photo upload
  (`RATE_LIMIT_SENSITIVE_PER_MINUTE`) and for tracking (`RATE_LIMIT_TRACKING_PER_MINUTE`, per IP). The key set is
  bounded (`RATE_LIMIT_MAX_TRACKED_KEYS`), so rotating identities cannot grow memory.
- `X-Forwarded-For`, `X-Real-IP` and `Forwarded` are **ignored** unless `TRUST_PROXY=true` (only behind a proxy
  you control). The compose setup has no proxy, so a spoofed header cannot buy a fresh bucket or burn someone
  else's.
- Slowloris: sockets that do not deliver a request head within `HEADERS_TIMEOUT_MS`, or a body within
  `REQUEST_TIMEOUT_MS`, are destroyed by a sweep every 500 ms (Node's own check runs only every 30 s).
- Body limits (256 KB JSON, 5 MB photos), `415` for non-JSON bodies, strict Zod schemas (unknown keys are errors),
  `statement_timeout` on the pool, `helmet`, CORS allowlist, `Cache-Control: no-store`.
- Defaults are generous enough for real use and for the 50-parallel-requests scenarios; the abuse suite runs with
  scaled-down limits.

### Decisions

- Prices, codes and tokens are generated only on the server; the 6-digit handover code uses `crypto.randomInt`.
- A delivery's code is shown to the recipient on the tracking page and never sent to couriers or senders.
- `attempt_no` is the number of the current attempt; it grows when a failed delivery is assigned again.
- The cash a courier is expected to hand in is the sum of `cod_collected_kop` of deliveries attributed to the shift.
  A handover that arrives after the shift was closed is recorded in `cash_adjustments` and does not change the
  closed figures.
- "Assigned to delivered" time in the report uses `deliveries.assigned_at` (the latest assignment).
- Report days and "next day" use `Europe/Kyiv`.
- Search: `DLV-000123` / `123` match the number; a full or partial phone matches by exact value or prefix (never a
  leading wildcard, so it uses the index); any other text matches nothing.

### API tests (`pnpm --filter @courier/api test`; need the running Supabase)

| File                 | What it does                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invariants.test.ts` | invariants 1–9, 11, 14 with real concurrent HTTP: 10 identical creates, 50 parallel creates, two dispatchers racing 25 times, 7+2 assignments 25 times, 40 cancel-vs-pickup races, 20 parallel wrong codes, the same batch 8 times in parallel, offline handover after reassignment, cash vs late handover 20 races, photo idempotency |
| `lifecycle.test.ts`  | acceptance flows (3, 4, 5), every assignment refusal, cancel rules, price quote vs tariff, 22 invalid-create cases, role × route matrix, search / filters / pagination against SQL, board and report against SQL, tracking privacy, uniform errors                                                                                     |
| `abuse.test.ts`      | a flood from `127.0.0.2` while a victim on `127.0.0.3` keeps working, `X-Forwarded-For` spoofing, in-flight fairness, per-user budgets, tracking enumeration, 150 slowloris sockets, 13 hostile payloads, malformed URLs and headers, CORS, 25 forged / tampered / confused JWTs                                                       |
| `fuzz.test.ts`       | ~1 350 generated requests over every route and role: never a 5xx, always the error format                                                                                                                                                                                                                                              |
| `src/**/*.test.ts`   | pure unit tests (`pnpm test:unit`): token bucket properties, error mapping, search intent, image sniffing, env parsing                                                                                                                                                                                                                 |

Bugs these tests found: the same lock-upgrade deadlock as in the database, this time in the action processor
(shared FK lock then exclusive lock: fixed by locking delivery → courier before inserting the action row),
tokens without an `exp` claim being accepted, a trickling request body not being cut off, partial phone numbers
that look like full ones not matching by prefix, framework-wrapped JSON errors being reported as validation errors.

## Sender notifications (webhooks)

Every status change writes an outbox row in the **same transaction** (database trigger), so changes made by the
`pg_cron` job and by the API are covered alike, and a rolled-back change leaves no notification. The `api` worker
(`WEBHOOK_POLL_INTERVAL_MS`) sends them.

- **Request:** `POST <sender url>` with the JSON payload (`id`, `deliveryId`, `number`, `event`, `status`,
  `previousStatus`, `attemptNo`, `occurredAt`, `deviceTime`; never the code, tracking token, phone or address) and headers
  `Webhook-Id` (the notification id, **the same on every retry and manual resend**), `Webhook-Timestamp` (unix seconds of
  this attempt) and `Webhook-Signature: v1=<hex HMAC-SHA256(secret, "<id>.<timestamp>.<raw body>")>`. Any 2xx is success.
- **Order:** only the head of each delivery's queue (the lowest pending `seq`) is eligible, so `delivered` can never
  be sent before `picked_up` has been acknowledged. Different deliveries are independent.
- **Retries:** pause = 30 s · 2^(n−1) ±20 % jitter, capped at 24 h, forever (nothing is dropped). A request that gets no
  answer is cut after `WEBHOOK_TIMEOUT_MS` and counts as a failure (`timeout`). 3xx is a failure (redirects are never followed).
- **Concurrency:** rows are claimed with `FOR UPDATE SKIP LOCKED` and stay locked while the request is in flight: several
  workers or API instances never send the same notification twice.
- **Time:** the worker uses the injected clock, so tests move time instead of sleeping.
- **Sender UI/API:** `GET /notifications` (filters, paging), `GET /notifications/:id` (attempt log: status, error,
  duration, manual flag), `POST /notifications/:id/resend` (one immediate attempt, logged as manual; it cannot complete a
  notification out of order), `GET/PUT /webhook` (URL and secret).
- **SSRF guard:** only http(s), no credentials in the URL, no private, loopback, link-local (cloud metadata), CGNAT or
  `.internal`/`.local` addresses; hostnames are resolved and **every** address must be public. Hosts in
  `WEBHOOK_ALLOWED_PRIVATE_HOSTS` (default `sender-stub,localhost,127.0.0.1`) are trusted. The check runs when saving
  _and_ when sending. Known limit: a DNS answer can change between the check and the connection.
- **Sender stub** (`apps/sender-stub`, port 5000): `POST /hook` records and verifies, `GET /` shows what arrived with a
  switch **Answer 200 / Answer 500 / Do not answer**, `GET /api/received`, `POST /api/mode`, `POST /api/reset`.
  The seeded senders all point at `http://sender-stub:5000/hook` with secret `whsec_demo_change_me`.

Tests (`webhooks.test.ts`, 31, plus 5 for the stub): signatures checked by an independent implementation, ordering
while an earlier notification fails, the 30 s … 24 h schedule over 16 attempts, "stub hangs for 10 minutes then
works → everything arrives in order", same id on retries, parallel workers, the full three-failures flow, manual resend,
16 forbidden URLs, DNS-rebinding style resolution, redirects, the background loop, no secrets in payloads.

## Money, tariff and rounding

Money is always an integer number of kopecks.

| Part                   | Rule                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base fee               | zone `A` 60 ₴, `B` 80 ₴, `C` 110 ₴                                                                                                                    |
| Weight                 | 1 g – 30 kg. +8 ₴ for every started kilogram above the first: 1000 g costs the base, 1001 g costs base + 8 ₴                                          |
| Cash on delivery (COD) | 0 – 100 000 ₴. Commission = 2 % of the COD amount, minimum 20 ₴. Zero COD has no commission                                                           |
| Rounding               | The commission is rounded **half up to the kopeck**, in integer arithmetic: `floor((cod × 2 + 50) / 100)`. Example: 1000.25 ₴ → 2000.5 kop → 2001 kop |
| Totals                 | `total = fee + commission` is what the sender pays. The recipient separately pays `cod` to the courier                                                |

Only the server computes prices. The sender's form asks the API for a quote on every change.

## Status table

Statuses: `created`, `assigned`, `picked_up`, `delivered`, `failed_attempt`, `returning`, `returned`,
`cancelled`.

| From                  | To               | Who        | Condition                                                             |
| --------------------- | ---------------- | ---------- | --------------------------------------------------------------------- |
| –                     | `created`        | sender     | create                                                                |
| `created`             | `assigned`       | dispatcher | courier has an open shift and fewer than 8 active deliveries          |
| `failed_attempt`      | `assigned`       | dispatcher | not before the next day (Europe/Kyiv midnight)                        |
| `assigned`            | `assigned`       | dispatcher | explicit reassignment to another courier                              |
| `assigned`            | `created`        | system     | not picked up within 45 minutes; the reason is written to the history |
| `created`, `assigned` | `cancelled`      | sender     | own delivery, before pickup                                           |
| `assigned`            | `picked_up`      | courier    | the assigned courier                                                  |
| `picked_up`           | `delivered`      | courier    | correct code, collected cash equals the COD amount                    |
| `picked_up`           | `failed_attempt` | courier    | reason and photo                                                      |
| `failed_attempt`      | `returning`      | system     | after the 3rd failed attempt (in the same transaction)                |
| `returning`           | `returned`       | dispatcher | parcel handed back to the sender                                      |

An offline handover with the correct code is also accepted from `created`, `assigned` and `failed_attempt`
(see the offline conflict table, planned). Terminal statuses: `delivered`, `returned`, `cancelled`.

"Active" for the 8-delivery limit means `assigned` + `picked_up`.

## Decisions

- "Today" and "next day" use the `Europe/Kyiv` time zone, including across daylight-saving changes.
- Webhook retry pauses double from 30 s up to 24 h and then repeat every 24 h; notifications are never dropped.
- Phone numbers are normalised to E.164; local Ukrainian forms (`0671234567`, `380…`) are accepted.
- API error codes live in `packages/shared/src/errors.ts` and are the only place that maps a code to an HTTP status.
