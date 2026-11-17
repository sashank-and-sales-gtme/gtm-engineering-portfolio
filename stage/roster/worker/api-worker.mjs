#!/usr/bin/env node
// The roster's research worker on the Claude API: the same job as the roster-research skill (claim, screen,
// research each company once and every contact separately, write briefs and email drafts, submit), run by a plain
// Node process with the product's own Anthropic API key instead of a Claude Code routine on someone's subscription.
//
//   node worker/api-worker.mjs                run once: work until the queue is empty or max_accounts_per_run is done
//   node worker/api-worker.mjs --loop         run, sleep ROSTER_POLL_SECONDS, run again (for a container)
//   node worker/api-worker.mjs --post-call    only post-call drafts and reschedule replies (fast lane)
//
// Env: ROSTER_WORKER_URL, ROSTER_WORKER_TOKEN, ANTHROPIC_API_KEY (or any credential the Anthropic SDK resolves).
// Optional: ROSTER_MODEL (default claude-opus-5-5), ROSTER_CONCURRENCY (4), ROSTER_POLL_SECONDS (300),
// ROSTER_WORKER_NAME (api-worker), ROSTER_AGENTS_DIR (the repository's .claude/agents).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentRunner, emptyUsage } from "./lib/agents.mjs";
import { RosterError, rosterClient } from "./lib/roster.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const args = new Set(process.argv.slice(2));
const MODEL = env.ROSTER_MODEL || "claude-opus-5-5";
const CONCURRENCY = Math.max(1, Number(env.ROSTER_CONCURRENCY) || 4);
const POLL_SECONDS = Math.max(30, Number(env.ROSTER_POLL_SECONDS) || 300);
const CLAIM = 5;

// Research budgets, the same as the agent files state. Writers get no search; the post-call writer may read the
// prospect's homepage once.
const BUDGET = {
  "company-screener": { searches: 1, fetches: 0 },
  "company-researcher": { searches: 5, fetches: 1 },
  "contact-researcher": { searches: 3, fetches: 1 },
  "post-call-writer": { searches: 0, fetches: 1 },
  "prep-writer": { searches: 0, fetches: 0 },
  "reschedule-writer": { searches: 0, fetches: 0 },
};
const FIX_BUDGET = { searches: 1, fetches: 1 };
const WRITER = { prep_brief: "prep-writer", post_call_email: "post-call-writer", reschedule_email: "reschedule-writer" };

const roster = rosterClient({ url: env.ROSTER_WORKER_URL, token: env.ROSTER_WORKER_TOKEN, worker: env.ROSTER_WORKER_NAME || "api-worker" });
const agents = agentRunner({
  agentsDir: env.ROSTER_AGENTS_DIR || resolve(here, "../../.claude/agents"),
  model: MODEL,
  efforts: { "company-screener": "low", "prep-writer": "low" },
});

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const errText = (e) => (e instanceof Error ? e.message : String(e));

/** Runs fn over items, at most n at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const problemLines = (problems) => Object.entries(problems ?? {}).flatMap(([k, list]) => list.map((p) => `${k}: ${p}`));

// ---------------------------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------------------------

/** One quick search per company to drop clear ICP failures before full research. Returns id -> company block. */
async function screen(tasks, usage) {
  const out = new Map();
  if (!tasks.length) return out;
  const brief = (t) => ({ id: t.id, company: t.company, domain: t.domain, apollo: t.apollo, manual: t.manual, seller: t.seller });
  let res;
  try {
    res = await agents.run("company-screener", {
      ask: "Screen these accounts. Every task gets exactly one entry in results.",
      input: { "Task files": tasks.map(brief) },
      searches: tasks.length,
      usage,
    });
  } catch (e) {
    log(`screen failed, researching all ${tasks.length}: ${errText(e)}`);
    return out;
  }
  for (const r of Array.isArray(res?.results) ? res.results : []) {
    const task = tasks.find((t) => t.id === r?.id);
    const ok = task && r.decision === "exclude" && !task.manual && /^https?:\/\//.test(String(r.source || "")) && String(r.reason || "").trim();
    if (!ok) continue;
    out.set(task.id, {
      exclude: true, screened: true, exclude_reason: String(r.reason).slice(0, 280), exclude_source: r.source,
      name: r.name || task.company, domain: r.domain || task.domain, segment: r.segment || r.reason, pain_points: [],
    });
  }
  log(`screen: ${out.size} excluded, ${tasks.length - out.size} to research`);
  return out;
}

const researchCompany = (t, usage, fix) =>
  agents.run("company-researcher", {
    ask: fix
      ? `Fix the company file for these problems. Keep every researched fact and source; change only what is needed:\n${fix.problems.join("\n")}`
      : "Research the company for this task and reply with the company JSON.",
    input: { "Task file": t, Homepage: t.domain ? `https://${t.domain}` : "none", ...(fix ? { "Company file": fix.previous } : {}) },
    ...(fix ? FIX_BUDGET : BUDGET["company-researcher"]),
    usage,
  });

const researchContact = (t, company, key, usage, fix) =>
  agents.run("contact-researcher", {
    ask: fix
      ? `Fix the contact file for these problems. Keep every researched fact and source; change only what is needed:\n${fix.problems.join("\n")}`
      : `Research contact ${key} and reply with their JSON.`,
    input: { "Task file": t, "Company file": company, "Contact key": key, ...(fix ? { "Contact file": fix.previous } : {}) },
    ...(fix ? FIX_BUDGET : BUDGET["contact-researcher"]),
    usage,
  });

const companyBlock = (c) => {
  if (c._cached) return { use_cached: true };
  const { _cached, ...rest } = c;
  return rest;
};

/** Researches the contacts of one account, submits, and fixes what the roster sends back (3 submits at most). */
async function finishAccount(t, company, usage, stats) {
  const contacts = new Map();
  const needsContacts = !(company.exclude === true && !t.manual);
  if (needsContacts) {
    await pool(t.people, CONCURRENCY, async (p) => {
      contacts.set(p.key, { ...(await researchContact(t, company, p.key, usage)), key: p.key });
    });
  }
  for (let submit = 1; submit <= 3; submit++) {
    const result = { company: companyBlock(company), contacts: [...contacts.values()] };
    const r = await roster.submit(t.id, result, usage);
    if (r.status === 200 && r.ok) {
      stats.accounts++;
      stats.leads += r.leads ?? 0;
      log(`ok ${t.id} ${t.company}: ${r.leads ?? 0} lead(s)${r.excluded?.length ? `, excluded ${r.excluded.join(",")}` : ""}`);
      return;
    }
    if (!r.retry) {
      stats.closed++;
      log(`closed ${t.id} ${t.company}: ${r.error ?? "rejected"}`);
      return;
    }
    // Usage is recorded with each submit; start a fresh count for the fixes.
    usage = emptyUsage();
    const problems = r.problems ?? {};
    log(`retry ${t.id} ${t.company}: ${problemLines(problems).join(" | ").slice(0, 300)}`);
    for (const [key, list] of Object.entries(problems)) {
      if (key === "company") {
        company = { ...(await researchCompany(t, usage, { problems: list, previous: company })), _cached: false };
      } else if (contacts.has(key)) {
        contacts.set(key, { ...(await researchContact(t, company, key, usage, { problems: list, previous: contacts.get(key) })), key });
      } else if (t.people.some((p) => p.key === key)) {
        contacts.set(key, { ...(await researchContact(t, company, key, usage)), key });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Prep briefs, post-call drafts, reschedule replies
// ---------------------------------------------------------------------------------------------------------------

async function finishWriting(t, usage, stats) {
  const name = WRITER[t.kind];
  let result = await agents.run(name, { ask: "Write the result for this task.", input: { "Task file": t }, ...BUDGET[name], usage });
  for (let submit = 1; submit <= 3; submit++) {
    const r = await roster.submit(t.id, result, usage);
    if (r.status === 200 && r.ok) {
      stats.drafts++;
      log(`ok ${t.id} ${t.kind}`);
      return;
    }
    if (!r.retry) {
      stats.closed++;
      log(`closed ${t.id} ${t.kind}: ${r.error ?? "rejected"}`);
      return;
    }
    usage = emptyUsage();
    const lines = problemLines(r.problems);
    log(`retry ${t.id} ${t.kind}: ${lines.join(" | ").slice(0, 300)}`);
    result = await agents.run(name, {
      ask: `Fix the result file for these problems. Change only what the problems name and keep everything else:\n${lines.join("\n")}`,
      input: { "Task file": t, "Result file": result },
      ...BUDGET[name],
      usage,
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------------------------------------------

async function release(t, e, usage, stats) {
  stats.released++;
  log(`release ${t.id}: ${errText(e)}`);
  if (e instanceof RosterError && e.status === 409) return; // the lease is gone; nothing to hand back
  await roster.release(t.id, errText(e), false, usage).catch((x) => log(`release ${t.id} failed: ${errText(x)}`));
}

async function processBatch(tasks, stats) {
  const usage = new Map(tasks.map((t) => [t.id, emptyUsage()]));
  const accounts = tasks.filter((t) => t.kind === "account");
  const writing = tasks.filter((t) => t.kind !== "account");

  const companies = new Map();
  for (const t of accounts) if (t.cached_company) companies.set(t.id, { ...t.cached_company, _cached: true });
  const toScreen = accounts.filter((t) => !companies.has(t.id) && !t.manual);
  // Screening is one call for the batch; its usage is booked on the first screened account.
  const screened = await screen(toScreen, usage.get(toScreen[0]?.id) ?? emptyUsage());
  for (const [id, c] of screened) companies.set(id, c);

  const jobs = [
    ...accounts.map((t) => async () => {
      const u = usage.get(t.id);
      try {
        if (!companies.has(t.id)) companies.set(t.id, { ...(await researchCompany(t, u)), _cached: false });
        await finishAccount(t, companies.get(t.id), u, stats);
      } catch (e) {
        await release(t, e, u, stats);
      }
    }),
    ...writing.map((t) => async () => {
      const u = usage.get(t.id);
      try {
        await finishWriting(t, u, stats);
      } catch (e) {
        await release(t, e, u, stats);
      }
    }),
  ];
  await pool(jobs, CONCURRENCY, (job) => job());
}

async function runOnce(postCall) {
  const stats = { accounts: 0, leads: 0, drafts: 0, closed: 0, released: 0 };
  const st = await roster.status();
  const q = st.queue ?? {};
  const b = st.budget;
  log(`queue: pending ${q.pending ?? 0}, running ${q.running ?? 0}, held ${q.held ?? 0} · model ${MODEL}` +
    (b ? ` · AI spend this month $${b.spent_usd.toFixed(2)}${b.limit_usd == null ? "" : ` of $${b.limit_usd}`}` : ""));
  if (!q.pending) return stats;
  const max = st.max_accounts_per_run ?? 15;
  let claimed = 0;
  while (postCall || claimed < max) {
    const kinds = postCall ? ["post_call_email", "reschedule_email"] : undefined;
    const { tasks, waiting_for } = await roster.claim(postCall ? 10 : Math.min(CLAIM, max - claimed), kinds);
    if (waiting_for === "budget") log("paused: this month's AI budget is used up (raise ai_budget.monthly_usd to continue)");
    if (waiting_for === "setup") log("paused: Admin > Setup has no seller profile yet");
    if (!tasks?.length) break;
    claimed += tasks.filter((t) => t.kind === "account").length;
    log(`claimed ${tasks.length}: ${tasks.map((t) => `${t.kind}${t.company ? ` ${t.company}` : ""}`).join(", ")}`);
    await processBatch(tasks, stats);
  }
  log(`done: ${stats.accounts} account(s), ${stats.leads} lead(s), ${stats.drafts} draft(s), ${stats.closed} closed, ${stats.released} released`);
  return stats;
}

const postCall = args.has("--post-call");
if (args.has("--loop")) {
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stopping = true));
  while (!stopping) {
    try {
      await runOnce(postCall);
    } catch (e) {
      log(`run failed: ${errText(e)}`);
    }
    for (let s = 0; s < POLL_SECONDS && !stopping; s++) await new Promise((r) => setTimeout(r, 1000));
  }
} else {
  await runOnce(postCall).catch((e) => {
    console.error(errText(e));
    process.exit(1);
  });
}
