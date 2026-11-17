# Architecture

```
.
├─ apps/
│  ├─ api/            NestJS + Drizzle; business logic in src/domain (functions), Nest classes thin
│  ├─ web/            Next.js 15, Feature-Sliced Design
│  │  ├─ app/         Next router only (thin)
│  │  └─ src/         app → pages → widgets → features → entities → shared
│  └─ sender-stub/    fake sender server for webhooks
├─ packages/
│  ├─ shared/         Zod schemas, status machine, tariff, errors (built to dist)
│  └─ db/             Drizzle schema + database tests
├─ supabase/          config.toml, migrations/, seed.sql
├─ e2e/               Playwright
├─ docker-compose.yml api, web, sender-stub
└─ plan.md, README.md
```

# Commands

```bash
cp .env.example .env
pnpm supabase start           # local Supabase (Docker)
docker compose up --build     # api :4000, web :3000, sender-stub :5000

pnpm build
pnpm lint                     # eslint + prettier + steiger
pnpm typecheck
pnpm test                     # unit, no services
pnpm test:integration         # db + api (supabase up, `docker compose stop api` first)
pnpm test:e2e                 # playwright (full stack up)
pnpm db:reset                 # rebuild DB from migrations + seed
```
