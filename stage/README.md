# Stage

Stage is the SDR workspace I'm building at StageProspct: the pipeline before your CRM. SDR teams work from one place instead of ten tabs. Researched accounts arrive in a weekly roster, contacts get enriched, meetings get prep briefs, post-call emails get drafted, and a prospect is written to HubSpot only when it is ready for the CRM.

This folder mirrors the product repository. The app lives in [roster/](roster/); its [README](roster/README.md) is the full deployment guide.

## Architecture

| Layer | What it uses |
|---|---|
| Frontend | Vite, React 18, TypeScript, deployed on Vercel. Tabs for Accounts, Meetings, Dashboard, Task Center and Admin, live through Supabase Realtime. |
| Data | Supabase Postgres with row level security, 33 migrations, multi-tenant workspaces, invite-only sign-up, per-workspace roles and permissions |
| Server logic | 18 Supabase Edge Functions: HubSpot sync and notes, CRM guard, Apollo and FullEnrich enrichment, Google Calendar, prep briefs, post-call and reschedule emails, OAuth callback, weekly roster |
| Scheduling | pg_cron jobs call the Edge Functions with a shared secret read from Supabase Vault |
| Research | A queue in Postgres claimed by a worker (`roster/worker`) that runs Claude Code agents: company screener, company researcher, contact researcher, prep writer, post-call writer, reschedule writer (`.claude/agents`) |
| Secrets | Integration keys and OAuth tokens per workspace in Supabase Vault. Enrichment and AI keys are bring-your-own, with no fallback to the platform's own keys. |

## Engineering choices worth a look

- **The database is the referee.** The worker never edits tables directly. It claims tasks and submits JSON, and Postgres functions validate every result before it lands.
- **Research once per company, separately per contact.** The company researcher runs once per account and contact researchers reuse its output, which keeps AI spend proportional to accounts rather than people.
- **Fit check before research.** The company screener filters accounts before the expensive research step runs.
- **Masked-surname matching.** When Apollo hides a surname ("Arjun Sh***a"), `linkedin.ts` finds the right profile through Exa by matching visible letters and confirming with role or company, and rejects namesakes.
- **Collision check before every call.** `crm-guard` answers "is it safe to call this person?" by checking every rep's roster and HubSpot live, then blocks or warns when another rep called recently or the contact is already a customer or open opportunity.

## Tests

- Deno unit tests next to the shared Edge Function code (`roster/supabase/functions/_shared/*_test.ts`): `deno test roster/supabase/functions/_shared/`
- Database tests with pgTAP (`roster/supabase/tests/db/`, run with `supabase test db`), including workspace isolation across tenants, plus SQL tests that CI runs against Postgres 17
- Worker tests (`roster/worker/test/`)

The CI definitions in `.github/workflows/` are kept as they run in the product repository. GitHub only runs workflows from a repository's root `.github` folder, so they do not execute here.

Test fixtures use fictional people and companies.
