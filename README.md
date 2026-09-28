# ainoviro Lead Collector — Backend

Backend API and workers for the ainoviro internal lead collector.
Finds vendor leads, enriches them with a contact email, cleans and de-duplicates
them, and exports a CSV for the external mailer. **This tool never sends email.**

The frontend lives in a separate repository (`ainoviro-collector-frontend`)
and talks to this API only over REST.

## Architecture (short)

- **One PostgreSQL database** stores all data and also runs the job queue
  (via `pg-boss`). There is no Redis.
- The API (`src/server.ts`) and the worker (`src/worker.ts`, added later)
  run as separate processes and share the same database.

## Requirements

- Node.js >= 20.12 (22 LTS recommended)
- A PostgreSQL database. We use [Neon](https://neon.tech) (managed, free tier).
  Any PostgreSQL 15+ also works.

## Local setup

```bash
# 1. Create your env file
cp .env.example .env        # macOS / Linux
copy .env.example .env      # Windows CMD

# 2. Put your real DATABASE_URL into .env

# 3. Install and run
npm install
npm run dev
```

The API listens on `http://localhost:5000` by default (configurable via `PORT`).
Health check: `GET http://localhost:5000/health`

## Scripts

| Script              | Purpose                       |
| ------------------- | ----------------------------- |
| `npm run dev`       | Start API with auto-reload    |
| `npm run build`     | Compile TypeScript to `dist/` |
| `npm start`         | Run compiled API              |
| `npm test`          | Run automated tests           |
| `npm run typecheck` | Type-check without emitting   |
| `npm run lint`      | ESLint                        |
| `npm run format`    | Prettier                      |

## Deployment

Planned for Render: Web Service (API), Background Worker (worker) and
Render Postgres (or Neon).

_More sections (env vars, compliance, backups) will be added as phases progress._