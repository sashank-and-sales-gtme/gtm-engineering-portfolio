# Stage Prospect - SDR Control Tower

A weekly outreach roster for SDR teams: researched accounts, contacts, meetings and tasks. Each workspace describes its own company, pitch and case studies in the onboarding wizard, and every research and writing step reads that profile.

- Frontend: Vite + React 18 + TypeScript, deployed on Vercel from a private GitHub repo.
- Backend: Supabase (Postgres with row level security, email and password sign-in, Realtime, Edge Functions, pg_cron).
- Research: a Claude worker (a Claude Code routine on your Claude subscription) researches the queued accounts and writes prep briefs. The app itself never calls Claude and needs no Anthropic API key.
- Integrations: HubSpot (OAuth app), Google Calendar (each person connects their own calendar), Apollo, FullEnrich (optional). All of them are connected from **Admin > Integrations** inside the app; keys and tokens are stored in Supabase Vault.

Tabs: Accounts, Meetings, Dashboard, Task Center and Admin. Everything updates live for everyone through Supabase Realtime.

```
.
├── index.html, vite.config.ts, tsconfig*.json, vercel.json, package.json
├── src/                      React app
│   ├── App.tsx               sign-in gate, header, tabs
│   ├── lib/                  supabase client, Google Calendar, permissions, data store, actions
│   └── components/           Accounts, Meetings, Dashboard, Task Center, Admin, modals
└── supabase/
    ├── migrations/           schema, RLS, functions, triggers, cron jobs
    ├── seed.sql              roles, app settings, roster data
    └── functions/            hubspot-note, prep-brief, add-company, weekly-roster,
                              queue-gate, claude-work, crm-guard, hubspot-sync,
                              integrations-status, integrations, oauth-callback, calendar
../.claude/                   (at the repository root) the Claude worker: roster-research skill, company-researcher, contact-researcher and prep-writer agents
worker/roster-worker.mjs      the worker's command line (claim, submit, release)
```

You need: a Supabase account, a Google Cloud project, a HubSpot developer account plus admin access to the HubSpot portal, an Apollo API key, a Claude plan that includes Claude Code (Max is the comfortable fit for four reps; see section 5), a personal GitHub account and a Vercel account. Install Node 18 or newer, the [Supabase CLI](https://supabase.com/docs/guides/cli) and `psql`.

---

## 1. Supabase

### 1.1 Create the project

1. In [supabase.com/dashboard](https://supabase.com/dashboard) click **New project**. Pick a region close to your team, set a strong database password and save it.
2. Open **Project Settings > API** and copy the **Project URL** and the **anon public** key. You need both for Vercel.
3. Open **Project Settings > Database > Connection string > URI** and copy it (replace `[YOUR-PASSWORD]`). This is `SUPABASE_DB_URL` below.
4. Open **Database > Extensions** and make sure `pg_cron`, `pg_net` and `supabase_vault` are enabled. (The migrations also try to enable them.)

### 1.2 Run the migrations and the seed

From the project folder:

```bash
npm install
supabase login
supabase link --project-ref YOUR-PROJECT-REF      # the ref is the subdomain of the Project URL
supabase db push                                  # applies supabase/migrations
psql "$SUPABASE_DB_URL" -f supabase/seed.sql      # roles, app settings, roster data
```

`supabase db push` creates every table, the RLS policies, the helper functions (`my_role`, `has_perm`, `undo_call` and the rest), the sign-up triggers and the cron jobs.

### 1.3 Vault secrets for the cron jobs

The cron jobs call the Edge Functions over HTTP. They read the project URL and a shared secret from Vault. In **SQL Editor** run (use your own values; make up a long random string for the cron secret and keep it for step 1.6):

```sql
select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'project_url');
select vault.create_secret('A-LONG-RANDOM-STRING', 'cron_secret');
```

### 1.4 Sign-in, and the Google OAuth client (Calendar)

People sign in with their email and a password. Google is only used for the Calendar connection each person makes in the app (and the optional invite mailbox), through one Google OAuth client.

**Google Cloud:**

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a project such as `stage-prospect`.
2. **APIs & Services > Library**: enable the **Google Calendar API**.
3. **APIs & Services > OAuth consent screen**: choose **External** (people sign in with any Google account; the database decides who gets in), fill the app name and support email. While the app is in Testing, add each person as a test user or publish it.
4. On the consent screen's **Scopes** step add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` and `https://www.googleapis.com/auth/calendar.events`.
5. **APIs & Services > Credentials > Create credentials > OAuth client ID**, type **Web application**.
   - Authorized JavaScript origins: `https://YOUR-APP.vercel.app` and `http://localhost:5173`.
   - Authorized redirect URI:
     - `https://YOUR-PROJECT-REF.supabase.co/functions/v1/oauth-callback` (the Calendar connection; **Admin > Integrations** shows this exact URL with a Copy button)
6. Copy the **Client ID** and **Client secret**. You paste them into **Admin > Integrations > Google Calendar** after deploying (section 4).

**Supabase:**

1. **Authentication > Providers > Email**: keep it on, with **Confirm email** on. Google sign-in stays off. Supabase's built-in email sender is fine to start with, but it only mails addresses that are members of your Supabase organisation (**Organization settings > Team**) and only a few an hour. So connect the invite mailbox (**Admin > Integrations > Invite email**): invites and resent sign-in links then go out from that Gmail account to anyone. Sign-up confirmations and password resets still use Supabase's sender until you add your own provider under **Authentication > Emails > SMTP Settings**.
2. **Authentication > URL Configuration** (the **Set up Supabase** workflow does this for you: it sets the Site URL to the environment's `APP_URL` and adds `APP_URL/**` and `http://localhost:5173/**` to the redirect URLs, keeping any already there):
   - Site URL: `https://YOUR-APP.vercel.app` (your production Vercel domain; set it after step 3 if you don't know it yet).
   - Redirect URLs: add `https://YOUR-APP.vercel.app/**`, `https://*-YOUR-VERCEL-TEAM.vercel.app/**` (preview deployments) and `http://localhost:5173/**`.

Sign-in is email and password, and invite-only: the database refuses any sign-up that isn't the owner (app setting `owner_email`) or someone with a pending invite. Setting `allowed_domain` (`{"domain": "example.com"}`) also lets anyone with an email at that domain sign up and wait for a role. Calendar access is asked for separately, when each person clicks **Connect my Google Calendar**.

### 1.5 HubSpot developer app

The roster connects to HubSpot through OAuth, so no token is pasted anywhere.

1. Sign in to [developers.hubspot.com](https://developers.hubspot.com) (create a free developer account if you don't have one) and open **Apps > Create app**. Name it `Outreach Roster`.
2. On the app's **Auth** tab:
   - Redirect URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/oauth-callback` (the same URL **Admin > Integrations** shows with a Copy button).
   - Required scopes: `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read`, `crm.objects.deals.read`, `crm.objects.owners.read`, `crm.schemas.contacts.read`, `sales-email-read`.
   - Optional scopes: `crm.objects.deals.write`, `crm.objects.meetings.read`.
3. Save, then copy the app's **Client ID** and **Client secret** for section 4.

Notes on contacts are written with the contacts write scope, so no separate notes scope is needed.

### 1.6 Function secrets and deploy

Only a few values still live in Supabase function secrets. Every API key and OAuth client is entered in the app later.

```bash
supabase secrets set \
  APP_URL=https://YOUR-APP.vercel.app \
  CRON_SECRET=A-LONG-RANDOM-STRING

supabase functions deploy
# the cron functions check CRON_SECRET themselves, claude-work checks the worker token, and oauth-callback
# is opened by the browser on its way back from HubSpot or Google, so deploy them without JWT checks
supabase functions deploy weekly-roster --no-verify-jwt
supabase functions deploy queue-gate --no-verify-jwt
supabase functions deploy hubspot-sync --no-verify-jwt
supabase functions deploy claude-work --no-verify-jwt
supabase functions deploy oauth-callback --no-verify-jwt

# if you are upgrading an earlier deploy, remove the old research worker
supabase functions delete research-worker
```

- `APP_URL` is your production Vercel URL. After connecting HubSpot or Google, the callback only sends people back to this origin (or to origins listed in the app setting `allowed_origins`, as `{"origins": ["https://..."]}`), so set it before connecting anything. Update it if your domain changes.
- `CRON_SECRET` must match the `cron_secret` value you stored in Vault.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided to functions automatically.

**Alternative: OAuth apps as function secrets.** The functions still read `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` (HubSpot app) and `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Google OAuth client) when nothing is saved in the app. Workspace data and AI keys (Apollo, FullEnrich, Anthropic) and HubSpot tokens are never read from function secrets; connect them in the app. Exa is different: the platform runs company research for every workspace, so its one key is platform-wide. Set it as the `EXA_API_KEY` function secret (`supabase secrets set EXA_API_KEY=...`); there is no place to enter it in the app. `CLAUDE_WORKER_TOKEN` is accepted as a fallback worker token, but creating one in the app is simpler.

Scheduled jobs (all times IST): weekly batch build Friday 8:00 PM, nightly HubSpot sync 11:22 PM (meetings, then HubSpot activity into the deal journeys), CRM check and quota release every 5 minutes. Admins can pause or run them from **Admin > Integrations**.

---

## 2. GitHub

1. On github.com (your personal account) click **New repository**, name it `stage-prospect-sdr-control-tower`, choose **Private**, and do not add a README or .gitignore.
2. In the project folder:

```bash
git init && git add . && git commit -m "Initial commit" && git branch -M main && git remote add origin https://github.com/<you>/stage-prospect-sdr-control-tower.git && git push -u origin main
```

`.env` files and `node_modules` are ignored, so no keys reach GitHub.

---

## 3. Vercel

1. In [vercel.com](https://vercel.com) click **Add New > Project** and import `stage-prospect-sdr-control-tower` (grant Vercel access to the private repo when asked).
2. Framework preset: **Vite**. Build command `npm run build`, output directory `dist` (the defaults).
3. Under **Environment Variables** add, for Production and Preview:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon public key
4. Click **Deploy**. Vite bakes these values in at build time, so after changing them use **Redeploy**.
5. Copy the production URL (for example `https://stage-prospect-sdr-control-tower.vercel.app`) and go back to Supabase **Authentication > URL Configuration**: set it as the Site URL and add it to Redirect URLs (step 1.4). Add it to the Google OAuth client's JavaScript origins too, and set it as the `APP_URL` function secret (step 1.6): `supabase secrets set APP_URL=https://YOUR-APP.vercel.app`.

`vercel.json` rewrites every path to `index.html`, so reloads on any URL work.

To run locally: copy `.env.example` to `.env`, fill both values, then `npm run dev` and open http://localhost:5173.

---

## 4. First sign-in and day-to-day admin

### 4.1 Owner

Open the Vercel URL, click **Invited? Create your account** and sign up with the owner's email address, then confirm it from the email (the seed sets `owner_email`; change it in `supabase/seed.sql` before the first deploy). The database recognizes the owner email (app setting `owner_email`) and makes that account the owner Super Admin, active immediately. The owner can't be demoted, suspended or removed.

### 4.2 Connect the integrations

Open **Admin > Integrations** as the owner. Each service has a card with a status (Connected, Needs attention or Not connected), the connected account and when it was last checked. Keys are checked live before they are saved, stored in Supabase Vault, and never shown again.

1. **Claude worker.** Click **Create worker token**, copy the token and the URL (shown once), and set up the routine as described in section 5. The card shows when the worker last ran and what is waiting in the queue.
2. **HubSpot.** Under **Set up HubSpot app**, paste the Client ID and Client secret from step 1.5 and save. Click **Connect HubSpot**, approve the app in HubSpot, and you land back in the roster. The roster then fills each active person's HubSpot owner id by matching their email; **Re-map owners** runs that again later.
3. **Google Calendar.** Under **Set up Google OAuth client**, paste the Client ID and Client secret from step 1.4 and save. Then click **Connect my Google Calendar**. Every colleague does this last step for themselves, from **Admin > Integrations** (or **Connections** for non-admins) or the **Connect calendar** link in the header.
4. **Apollo.** Paste the API key from Apollo (**Settings > Integrations > API**) and click **Save and test**.
5. **FullEnrich (optional).** Paste the API key and click **Save and test**. The card shows the remaining credits.

**Test** re-checks a connection; **Disconnect** removes the stored key or token. If a card shows **Needs attention**, its message says what failed (for example an expired HubSpot or Google grant); reconnect or save a fresh key.

### 4.3 Adding colleagues

Two ways:

- **Approve after sign-in.** Only when `allowed_domain` is set: a colleague at that domain signs in, lands on "Access needed" and appears in **Admin > Users** as *awaiting approval*. Pick a role in their row and click **Approve**.
- **Pre-assign by email.** In **Admin > Users**, enter their work email and a role, then **Pre-assign role**. When they sign in for the first time they get that role straight away.

Rules the app and the database both enforce: at most 2 active Super Admins (app setting `super_admin_limit`); only a Super Admin can grant or remove Super Admin; nobody changes their own role or status. Suspend cuts access without deleting anything, and Restore brings it back. Every user, role, permission and scheduled task change is written to **Admin > Audit log**.

Roles live in **Admin > Roles and permissions**. Super Admin, Admin, SDR and Viewer come seeded; add your own and tick permissions. A role can't be deleted while anyone holds it.

### 4.3a Reps and segments

**Admin > Reps and segments** decides who gets a weekly batch. For each person, tick **In rotation**, set **Accounts / week** (100 by default) and, optionally, their segment: employees, revenue (US$ millions) and total funding (US$ millions). Empty fields mean no limit; employees default to 250 to 2500. Save the row. A new rep is added the same way the moment they are approved; **Build now** fills their batch straight away instead of waiting for Friday.

Each account goes to one rep only (Supabase keeps an ownership record per company), so overlapping segments never put two reps on the same company. The panel warns when segments overlap and shows, per rep, how many accounts of the next batch are ready, in research, held in reserve or dropped.

**Roster settings** on the same page: contacts per account (2 by default), how many accounts one worker run takes (15), the reserve multiplier (1.5) and the CRM "recently contacted" window (90 days).

### 4.4 HubSpot owner ids

Each person who books demos needs their HubSpot owner id in **Admin > Users > HubSpot owner id**. It is used to:

- own the HubSpot contacts created from "Call connected?" notes, and
- match the nightly sync (deals where `booked_by_sdr` is that owner, plus meetings on contacts and companies they own) back to that person.

Connecting HubSpot fills these automatically for everyone whose roster email matches a HubSpot user; **Admin > Integrations > HubSpot > Re-map owners** lists anyone it could not match. To set one by hand, find the id in HubSpot under **Settings > Users & Teams** (open the user; the id is in the URL).

### 4.5 Costs and credits

- **Apollo.** The weekly search uses Apollo's people search, which does not spend credits. "Enrich now" uses a standard people match (work email only, no phone, no waterfall), about 1 credit per person. The Add company dialog shows the count before anything is spent.
- **Claude.** Research and prep briefs run on your Claude subscription through Claude Code; there is no per-token bill. Usage counts against the plan's limits, so the worker researches each company once (reused for every contact and for 90 days), stops at the first ICP failure, spends a fixed budget per company (3 searches and the homepage, plus 2 when they can change the tier) and gives every contact their own researcher with up to 3 searches and 1 page for the person fit check, and only researches reserve accounts when a rep is short of quota. A funding filter in a rep's segment spends Apollo credits (1 per 100 companies), not Claude usage.
- **FullEnrich.** Only used when its key is set and Apollo returns no email; each lookup spends FullEnrich credits.
- **Supabase.** The free plan works for testing, but free projects pause after a week without traffic and that stops the cron jobs. The Pro plan (about $25 a month) is the safe choice.
- **Vercel.** Hobby is free for personal, non-commercial projects; Vercel's terms ask commercial teams to use Pro.
- **HubSpot and Google.** The HubSpot app and the Calendar API add no cost.

### 4.6 How it works

- **Sign-in.** Invite-only email and password sign-in (see 1.4). Invite links land on a "choose your password" screen; **Forgot password?** sends a reset link. Support for Microsoft and Zoho sign-in is planned.
- **HubSpot.** Calls go through one HubSpot OAuth connection on the server. Notes show the connected app as the creator; new contacts are owned by the rep through their HubSpot owner id. Notes are saved only for roles with "Save call context to HubSpot".
- **Google Calendar.** Each person connects their own calendar once; the server keeps the refresh token in Vault and makes calendar blocks, deletions and Meet link lookups for them.
- **Scheduled work.** The weekly roster, the research gates, add-company requests and the nightly HubSpot sync run as Supabase Edge Functions on pg_cron. Admin > Integrations shows each connection and lets admins pause or run the jobs.
- **Research and prep briefs.** Both are queued in Supabase and done by the Claude worker (section 5). Every result is validated by the `claude-work` function before a lead or brief is written.
- **Security.** Row level security in Postgres is the real guard. The app hides what your role can't do, but the database refuses it even if someone tries directly.

---

## 5. The Claude worker

The app queues work; Claude Code does it on your Claude subscription; Supabase checks the result. No Anthropic API key is involved.

```
Friday 8 PM  weekly-roster   Apollo search per rep segment -> accounts reserved to one rep -> queue (gating)
every 5 min  queue-gate      HubSpot + roster dedupe (fails closed) -> enrichment for "add now" -> reserve (held)
                             -> released to Claude only while a rep is short of quota (pending)
routine      Claude Code     roster-research skill: claim -> company-researcher (once per account) -> contact-researcher (one per person, in parallel) -> assemble -> submit
on submit    claude-work     validates the JSON (ICP fields, sources, house style), writes leads assigned to the rep
```

### 5.1 Set up the routine (runs in the cloud)

1. Push this repository to GitHub (section 2). The app is in `roster/`; the worker files sit at the repository root: `.claude/skills/roster-research`, `.claude/agents/company-researcher.md`, `.claude/agents/contact-researcher.md`, `.claude/agents/prep-writer.md` and `worker/roster-worker.mjs`.
2. In **Admin > Integrations > Claude worker**, click **Create worker token**. Copy `ROSTER_WORKER_TOKEN` and `ROSTER_WORKER_URL`; the token is shown once.
3. At [claude.ai/code](https://claude.ai/code), create a routine on the repository:
   - Prompt: `Run the roster-research skill.`
   - Schedule: every 3 hours. During the Friday-to-Sunday build, every hour clears four reps' batches comfortably.
   - Environment: add `ROSTER_WORKER_TOKEN` and `ROSTER_WORKER_URL` as environment variables, and allow network access to `YOUR-PROJECT-REF.supabase.co`.
   - Model: Sonnet is the right default for the routine; the research subagent runs on Sonnet regardless.
4. Run it once by hand and check the card: **Last claim** and **accounts researched** should move.

To run the worker on your own machine instead, open the repository in Claude Code with the two variables exported and ask it to run the roster-research skill.

### 5.2 Usage and limits

A week for four reps is about 400 accounts and 800 contacts. With company research reused, early exits and the search budget, that is a few hundred subagent runs spread over the weekend. If the routine starts hitting plan limits, lower **Accounts per Claude worker run**, run the routine more often with fewer accounts each time, or move the build earlier in the week. Prep briefs and add-company requests jump the queue (priority 1 and 2), so they are picked up on the next run.

Anthropic's terms say a Claude subscription is for your own use of Claude Code. Here, the worker is you running Claude Code on your own work, and the app never handles Claude credentials or calls Claude for other users. Advertised plan limits assume ordinary individual usage, so if the routine runs very heavy volumes, confirm with Anthropic (the Claude Code legal and compliance page has the contact) or move research to an API key later.

### 5.3 CRM as a second source of truth

- Before research: every account and contact is checked in HubSpot (company with deals, customer or opportunity stage, owned by another rep, contacted within the window) and on the roster (same Apollo person, LinkedIn or name at the company, across all reps). If HubSpot can't be reached the account waits and is retried; it is never researched unchecked.
- Person fit check: Apollo's title, seniority and location filters are treated as a starting point. Every contact is verified by their own researcher: in the role now (with a URL), based in India, the role really covers demand gen, growth or digital (not brand, PR or content only), Head level or above, India/APAC or global scope, time in role, the metrics they own and recent signals. Supabase rejects any contact without this check, and a failed check is excluded. The result shows under "Person check" in the contact's research.
- Before a call: each approved contact card runs a live check (roster calls by other reps, HubSpot owner, lifecycle stage, last activity) and shows **CRM clear**, **Check before calling** or **Someone else is working this person**, with the reasons.
- Every night: HubSpot calls, emails, notes and meetings on roster contacts are copied into the deal journey, marked "From HubSpot".



### 5.4 Post-call emails

Saving a call note ("Log connected call") queues a follow-up email draft for the worker (`post_call_email` in `research_queue`, priority 2 like prep briefs). The `post-call-writer` subagent drafts it from the note, the roster research and the deal journey, with at most one look at the prospect's homepage. The draft appears under the note in the deal journey, where reps edit, copy or regenerate it. Nothing is ever sent.

- **Format.** A **note** (at most 50 words, excluding greeting, ask and sign-off) for the person on the call, or a **brief** (at most 75 words of written copy) when the note says it will be shared. The app adds the locked product overview and instance links to briefs. The writing rules live in `.claude/agents/post-call-writer.md`.
- **Checks.** `claude-work` rejects a draft with missing parts, dashes, banned product terms, an off-format subject or a blown word cap, and sends it back for a fix. On the third submit, style misses are saved as "Check before sending" flags instead.
- **Declined calls** are not drafted automatically; every note has a "Draft follow-up email" button.
- **Code:** `supabase/functions/post-call-email`, `_shared/postcall.ts`, `_shared/postcall_lib.ts` (pure, tested), migration `20261015000010_post_call_email.sql`.

**Speed.** By default a draft is written on the worker's next scheduled run. To have drafts within minutes, add a second routine that only does post-call drafts:

1. At claude.ai/code/routines, create a routine on this repository with the prompt `Run the roster-research skill in post-call mode.`, the same environment as the main routine, no connectors, and an **API** trigger. Optionally add an hourly schedule as a backstop.
2. Open the API trigger, copy its URL and generate a token (shown once).
3. In **Admin > Integrations > Routine wake-ups**, paste them under "Post-call routine" and save. The main research routine can be woken the same way ("Research routine").

Saving a note then wakes that routine. Wake-ups within 20 seconds share one run, and each run drafts everything waiting. Without a trigger the app simply waits for the scheduled run. Each workspace saves its own triggers (Vault secrets `int_post_call_wake` / `int_research_wake`). The older `POST_CALL_WAKE_*` / `RESEARCH_WAKE_*` function secrets still work for the starting workspace only.

### 5.5 The API worker (Anthropic API key instead of a subscription)

`roster/worker/api-worker.mjs` does the same work as the routine through the Anthropic API, so research can run as a normal service for many sellers. It speaks the same claim / submit / release protocol to `claude-work`, reuses the agent instructions in `.claude/agents/`, gives each agent the same search budget with the API's web search and web fetch tools, and sends each rejected result back to the agent for a fix (three submits, as before). Token and search usage is reported with every submit and release and shows in the Claude worker card.

```
cd roster/worker && npm ci
export ROSTER_WORKER_URL=... ROSTER_WORKER_TOKEN=... ANTHROPIC_API_KEY=...
node api-worker.mjs            # one pass: claim, research, submit
node api-worker.mjs --loop     # keep polling (ROSTER_POLL_SECONDS, default 300)
node api-worker.mjs --post-call  # only post-call drafts and reschedule replies
npm test
```

Optional: `ROSTER_MODEL` (default `claude-opus-5-5`), `ROSTER_CONCURRENCY` (default 4), `ROSTER_WORKER_NAME`. To deploy it, build `roster/worker/Dockerfile` from the repository root and run it on any container host with those variables set.

## 6. Seller profile and the setup wizard

Who is selling is never written into the code or the agent files. **Admin > Setup** walks an admin through eight steps, with a tick beside each one that's done:

1. **Company**: name, website, what you sell, the pitch in your own words, the product overview for emails, the booking link and (for the owner) the workspace name.
2. **Context**: the document library. Upload sales decks, case studies, call notes, one-pagers and price sheets (PDF, DOCX, PPTX, CSV, Markdown or text are read in full; PNG, JPG, MOV, MP4, WAV and MP3 are kept but can't be read yet), and add links. The website and every case-study link are added for you when you save them.
3. **Customers and proof**, 4. **Target companies** (size, exclusions, never-target list, competitor categories, adjacency hooks), 5. **Personas and pains**: for each active persona, its pains, the signs that a company has each one, and the proof point that answers it. 6. **Writing rules**, 7. **Team and tools** (reps in rotation, Apollo, the Claude worker, HubSpot, Calendar, FullEnrich; Exa is the platform's and needs nothing), 8. **Review**.

Each step saves on its own and shows what's missing under the field. Research, the weekly build and email drafts wait until the required steps (company, proof, target companies, at least one persona's pains) are done and **Finish setup** is pressed. Until then the admin lands on Setup at sign-in, and Accounts shows a getting-started checklist instead of an empty table.

The profile is stored in `app_settings` (`profile`), the pains in `icp`; every function and agent reads them. Uploaded files sit in the private Storage bucket `workspace-docs` under the workspace's own folder, and `workspace_documents` holds the text the `documents` function extracted from each file or link (migration `20261027000032_onboarding.sql`). Researchers and writers get excerpts of every read document with each task (`insider_context`), shared fairly across documents and capped per task. Migration `20261024000029_seller_profile.sql` marks setup as done for workspaces that existed before the wizard.

## 6a. Workspaces

Each customer company is a **workspace**. Every table carries `workspace_id`; a restrictive RLS policy keeps each person to their own workspace, and every edge function scopes its service-role queries to the caller's workspace (`_shared/workspace.ts`, `adminClient()` in `_shared/supabase.ts`). Scheduled jobs run once per workspace. API keys, OAuth tokens and the worker token belong to the workspace; only the HubSpot app, the Google OAuth client and the OAuth state key are shared by the platform.

- **Sign-up.** The owner email joins the starting workspace, and invited people join the workspace that invited them. Anyone else is refused unless `platform_settings` `signup` is open or lists their address, when they get a new workspace of their own. Migration `20261026000031_workspaces.sql`.
- **Platform admins** (`platform_settings` `admins`) manage the shared OAuth apps and the scheduler. Workspace Super Admins manage everything else in their own workspace.
- **Tests:** `supabase/tests/db/workspace_isolation_test.sql`, `signup_test.sql`.

## 7. Planned improvements

- **Sign-in providers.** An OAuth module covering Google, Microsoft and Zoho sign-in. Today sign-in is Google only and invite-only (owner email plus invites), with an optional single Workspace domain (`allowed_domain`).

## 8. Environments and deploys

| | Staging | Production |
|---|---|---|
| Git branch | `staging` | `main` |
| Supabase project | `stage-prospect-staging` | `outreach-cc-public` |
| Vercel | preview deployments (`…-git-staging-…vercel.app`) | `stage-prospect-sdr-control-tower.vercel.app` |
| GitHub environment | `staging` | `production` (add required reviewers to gate deploys) |

- Work lands on `staging` first. A push there deploys the edge functions to the staging project; Vercel builds a preview against the staging database (its Preview and Development env vars point there).
- **Migrations** run through **Actions > Set up Supabase** with a target. Run it for staging, check the app, then run it for production *before* merging to `main`, so the database is ready when the new functions deploy.
- Merging to `main` deploys the functions to production and Vercel deploys the frontend.
- Each GitHub environment holds `PROJECT_REF` and `APP_URL` variables and a `SUPABASE_DB_PASSWORD` secret (production can use the repository-level one). `SUPABASE_ACCESS_TOKEN` is shared.
- CI on every pull request: function type-check and tests, frontend type-check and build, worker tests, the SQL unit tests, and a full rebuild of the database from all migrations plus the seed with the pgTAP tests in `supabase/tests/db`.
- **AI budget:** app setting `ai_budget` (`monthly_usd`, default 50; prices per million tokens default to Claude Opus 5.5 list prices; `web_search_usd` is 0 until you set it). At the limit the worker stops claiming work until the next month or until the limit is raised. `monthly_usd: null` removes the cap.
- **API keys:** Apollo, FullEnrich and Anthropic keys must be connected in Admin > Integrations by each workspace. The server's environment variables are no longer used as a fallback for them (only the HubSpot and Google OAuth app credentials, and the platform's Exa key, still are). Exa is platform-provided: workspaces never connect it.
