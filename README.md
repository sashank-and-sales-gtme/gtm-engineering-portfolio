# GTM Engineering Portfolio

Sashank Koundinya. Three systems I designed and built to move B2B teams from a target account to a booked conversation: account research and routing, a direct-mail campaign run end to end by automation, and a prospecting workspace for SDR teams.

| Project | What it does | Stack |
|---|---|---|
| [Rover](rover/) | Connects a customer's CRM and team chat to n8n through OAuth, then runs an allbound workflow that qualifies inbound accounts against an ICP, researches them with Exa and Claude, finds the buying committee and writes everything to HubSpot and Slack. | FastAPI, React, n8n, Exa, Claude, Apollo, HubSpot, Slack |
| [Caricature Campaign](caricature-campaign/) | Runs a physical direct-mail campaign (a caricature of each prospect with a QR card) as a 13-day state machine: courier tracking, first-party website intent, percentile-tiered scoring, Instantly sequences, rep call tasks and human-approved AI nurture emails. | n8n, Supabase (Postgres views), Ship24, Instantly, HubSpot, Claude |
| [Stage](stage/) | A multi-tenant workspace for SDR teams: "the pipeline before your CRM". Weekly researched account rosters, contact enrichment, meeting prep briefs, post-call emails and task management, with HubSpot sync only once a prospect is ready. | React, TypeScript, Supabase (RLS, Edge Functions, Realtime, pg_cron), Claude Code agents |

## What this shows

- **Systems over scripts.** Each project keeps state in one place (Postgres or the CRM) and treats every external tool as replaceable through configuration.
- **Data you can audit.** Every research claim carries a source ID, every intent signal lands in an event log, and every CRM write is logged against the record it touched.
- **Cost and safety controls.** Fit checks run before expensive research, enrichment keys are bring-your-own per workspace, OAuth tokens are encrypted at rest, and AI-written outreach waits for human approval.
- **Tested before shipped.** Rover's API has a pytest suite with mocked provider and n8n calls. The caricature campaign's scoring logic is asserted in SQL against Postgres, and its workflow logic is executed against mock payloads. Stage runs Deno, database and worker tests in CI.

## Repository layout

```
rover/
  backend/            FastAPI service: auth, MFA, OAuth broker, n8n credential handoff, tests
  frontend/           React + Vite connection dashboard
  workflows/          Allbound account research workflow for n8n, plus the Python generator that builds it
caricature-campaign/
  workflows/          Six n8n workflows
  supabase/           Schema, event log and scoring views
  website/            First-party tracking snippet
  generator/          Python generator for the six workflows
  tests/              Workflow, snippet and SQL view tests
  docs/               Campaign brief and setup guide
stage/
  roster/             The Stage app: React frontend, Supabase backend, research worker
  .claude/            Claude Code agents and the research worker skill
  .github/workflows/  CI pipelines as used in the product repository (they do not run from this subfolder)
```

## Running the tests

```bash
# Rover API
cd rover/backend && pip install -r requirements-dev.txt && pytest

# Caricature campaign workflows and website snippet
cd caricature-campaign/tests && npm install && npm test

# Caricature campaign scoring views (needs a scratch Postgres database)
psql "$DATABASE_URL" -f caricature-campaign/supabase/migration.sql -f caricature-campaign/tests/sql/views_test.sql
```

Stage's own tests are described in [stage/README.md](stage/README.md).

## Rights

Published for review as part of my portfolio. All rights reserved; no license is granted to copy, modify or redistribute this code.
