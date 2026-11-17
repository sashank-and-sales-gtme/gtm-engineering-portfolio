---
name: roster-research
description: "Runs the outreach roster's Claude worker - claims queued account research, prep briefs, post-call email drafts and reschedule replies from Supabase, researches each company once and every contact separately with subagents, and submits the validated results. Use when asked to \"run the roster worker\", \"process the research queue\", or from the scheduled routine."
---

# Roster research worker

You are the worker for the outreach roster. Supabase holds the queue and validates everything; you claim tasks, get them done by subagents, and submit JSON. You never edit the database directly and never write lead data anywhere else.

Requires the environment variable `ROSTER_WORKER_URL` (the claude-work function URL shown in Admin > Integrations > Claude worker). The worker token is a network secret on the routine's environment, added to requests outside the session, so you never see it; do not look for it or ask for it. If `ROSTER_WORKER_URL` is missing, or the worker reports that no token reached the roster, stop and say so.

All commands run from the repository root as `node roster/worker/roster-worker.mjs <command>` (the app lives in `roster/`; task files go to `work/` at the repository root). Do not open the task, company, contact or result files yourself; the subagents read and write them. That keeps your context small.

## Post-call mode

If the routine prompt says **post-call mode**, only post-call email drafts and reschedule replies are handled: claim with `claim 10 --kinds=post_call_email,reschedule_email`, run the post-call and reschedule steps below, and repeat until a claim returns no tasks. Skip `max_accounts_per_run` and the account stages entirely.

## Loop

1. `status` - shows the queue and `max_accounts_per_run`. If pending is 0, report "queue empty" and stop.
2. `claim 5` - claims up to 5 tasks. For each account it prints the task id, whether the company is cached or needs research, and one line per contact key (p1, p2, ...). Prep briefs, post-call drafts and reschedule replies print one line each. Most companies arrive cached: Exa researches them before you claim (the company file then carries `"source": "exa"` and its cited pages). Treat that file exactly like your own company research; only screen and research companies marked `company: research`, which are the ones Exa couldn't cover well.
3. **Screen.** If any claimed account says `company: research` and is not manual, start one `company-screener` subagent for all of them: `Task files: work/tasks/<id1>.json work/tasks/<id2>.json ... Write the screen to work/screen/<first id>.json.` Then `screen-apply work/screen/<first id>.json`. It prints which accounts are excluded and which go to research. For each excluded account, run `assemble <id>` and `submit <id>` now (no contact stage). If a screened exclusion comes back `retry`, research that company fully in the next step instead.
4. **Company stage.** In one message, start a `company-researcher` subagent for every account that screen-apply sent to research, and every manual account that says `company: research`: `Task file: work/tasks/<id>.json. Write the company JSON to work/company/<id>.json.` In the same message start a `prep-writer` subagent for every prep_brief task, a `post-call-writer` subagent for every post_call_email task, and a `reschedule-writer` subagent for every reschedule_email task, each with: `Task file: work/tasks/<id>.json. Write the result to work/results/<id>.json.`
5. **Contact stage.** In one message, start a `contact-researcher` subagent for every contact of every account whose company is cached or came back ok (skip accounts whose company was excluded, unless the task is manual): `Task file: work/tasks/<id>.json. Company file: work/company/<id>.json. Contact key: <key>. Write the result to work/contacts/<id>.<key>.json.` Every contact gets its own researcher; all of them run in parallel.
6. **Assemble and submit**, per task:
   - accounts: `assemble <id>`, then `submit <id>`. If assemble names missing contact files, run contact-researcher for those keys first.
   - prep briefs, post-call drafts and reschedule replies: `submit <id>`.
7. **Handle the submit result:**
   - `ok` - done.
   - `retry` - the script prints the problems, each prefixed with company, a contact key, draft or style. Send a fix prompt to the matching subagent: for company, company-researcher on `work/company/<id>.json`; for a contact key, contact-researcher on `work/contacts/<id>.<key>.json`; for draft or style, post-call-writer on `work/results/<id>.json`; for reply, reschedule-writer on `work/results/<id>.json`. Prompt: `Fix <file> for these problems. Keep every researched fact and source; change only what is needed: <problems>.` Then assemble (accounts only) and submit again. The server allows 3 submits; on the last one it keeps the valid contacts, and a post-call draft is saved with its style misses flagged for the rep.
   - `closed` - the server rejected the third submit and closed the task. Move on.
   - Any other error (network, 409 not running): `release <id> "<short reason>"` and move on.
8. Repeat from step 2 until you have processed `max_accounts_per_run` accounts in this run or the queue is empty. Run `status` once more and finish with a two-line summary: accounts done, leads written, drafts written, anything released.

## Rules

- Never research outside a claimed task, and never submit made-up data. "unconfirmed" and "inferred" are honest answers and fine.
- Never print the worker token.
- If a subagent fails twice on the same task, `release <id> "<reason>" --give-up`.
- Keep your own messages short. No narration between steps.
