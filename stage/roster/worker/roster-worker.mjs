#!/usr/bin/env node
// Command line for the roster's Claude worker. No dependencies (Node 18+).
//
//   node worker/roster-worker.mjs status
//   node worker/roster-worker.mjs claim [n] [--kinds=account,prep_brief,add_request,post_call_email,reschedule_email]
//   node worker/roster-worker.mjs screen-apply <screen.json>     apply company-screener verdicts (exclusions -> company files)
//   node worker/roster-worker.mjs assemble <id>                  merge work/company + work/contacts into work/results/<id>.json
//   node worker/roster-worker.mjs submit <id> [result.json]      (default work/results/<id>.json)
//   node worker/roster-worker.mjs release <id> [reason] [--give-up]
//
// Env: ROSTER_WORKER_URL (the claude-work function URL), optional ROSTER_WORKER_NAME.
// The worker token should be a network secret on the routine's cloud environment (Bearer, host = the
// Supabase project host): Anthropic's proxy adds it to requests after they leave the session, so the session
// never sees it. ROSTER_WORKER_TOKEN still works as a fallback for local runs.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const URL_ = process.env.ROSTER_WORKER_URL;
const TOKEN = process.env.ROSTER_WORKER_TOKEN;
const NAME = process.env.ROSTER_WORKER_NAME || "claude-code";
const TASKS = join("work", "tasks");
const RESULTS = join("work", "results");
const COMPANY = join("work", "company");
const CONTACTS = join("work", "contacts");
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const cleanup = (id) => {
  rmSync(join(TASKS, `${id}.json`), { force: true });
  rmSync(join(RESULTS, `${id}.json`), { force: true });
  rmSync(join(COMPANY, `${id}.json`), { force: true });
  try {
    for (const f of readdirSync(CONTACTS)) if (f.startsWith(`${id}.`)) rmSync(join(CONTACTS, f), { force: true });
  } catch {}
};

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function call(body) {
  if (!URL_) die("Set ROSTER_WORKER_URL first.");
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(URL_, {
        method: "POST",
        // Without a local token the request goes out bare and the environment's network secret adds it.
        headers: TOKEN ? { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
        body: JSON.stringify({ worker: NAME, ...body }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status >= 500 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      break;
    } catch (e) {
      if (attempt === 2) die(`Network error: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  const text = await res.text();
  if (res.status === 401 && !TOKEN) {
    die("The roster refused the request: no worker token reached it. Add the worker token as a network secret on this routine's environment (Bearer, host " + new URL(URL_).host + ").");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { ok: false, error: text.slice(0, 300) };
  }
  return { status: res.status, data };
}

const [cmd, ...args] = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => {
  const [k, v] = a.slice(2).split("=");
  return [k, v ?? true];
}));
const pos = args.filter((a) => !a.startsWith("--"));

if (cmd === "status") {
  const { status, data } = await call({ action: "status" });
  if (status !== 200) die(`status failed (${status}): ${data.error}`);
  const q = data.queue || {};
  console.log(`pending ${q.pending ?? 0} · running ${q.running ?? 0} · held ${q.held ?? 0} · gating ${q.gating ?? 0} · max_accounts_per_run ${data.max_accounts_per_run}`);
} else if (cmd === "claim") {
  const n = Number(pos[0] || 5);
  const kinds = typeof flags.kinds === "string" ? flags.kinds.split(",") : undefined;
  const { status, data } = await call({ action: "claim", n, kinds });
  if (status !== 200) die(`claim failed (${status}): ${data.error}`);
  for (const d of [TASKS, RESULTS, COMPANY, CONTACTS]) mkdirSync(d, { recursive: true });
  if (!data.tasks.length) console.log("no tasks claimed (queue empty)");
  for (const t of data.tasks) {
    writeFileSync(join(TASKS, `${t.id}.json`), JSON.stringify(t, null, 1));
    if (t.kind === "prep_brief") {
      console.log(`${t.id}  prep_brief  ${t.facts?.company ?? ""} / ${t.facts?.contact ?? ""}`);
      continue;
    }
    if (t.kind === "reschedule_email") {
      console.log(`${t.id}  reschedule_email  ${t.facts?.contact?.company ?? ""} / ${t.facts?.contact?.name ?? ""}  (${t.facts?.emails?.length ?? 0} emails, ${t.facts?.candidates?.length ?? 0} slots)`);
      continue;
    }
    if (t.kind === "post_call_email") {
      console.log(`${t.id}  post_call_email  ${t.facts?.account?.company ?? ""} / ${t.facts?.contact?.name ?? ""}  (${t.facts?.situation ?? ""})`);
      continue;
    }
    // Fresh cached company research: the company step is already done.
    if (t.cached_company) writeFileSync(join(COMPANY, `${t.id}.json`), JSON.stringify({ ...t.cached_company, _cached: true }, null, 1));
    console.log(`${t.id}  account  ${t.company} (${t.domain || "no domain"})${t.cached_company ? "  company: cached" : "  company: research"}${t.manual ? "  manual" : ""}`);
    for (const p of t.people) console.log(`    ${p.key}  ${p.name} (${p.title})`);
  }
} else if (cmd === "screen-apply") {
  // Applies a company-screener file: exclusions become company files (submitted as excluded), the rest go to research.
  const file = pos[0];
  if (!file || !existsSync(file)) die("usage: screen-apply <screen.json>");
  let res;
  try {
    res = readJson(file).results;
  } catch (e) {
    die(`screen file is not valid JSON (${e.message}); ask company-screener to rewrite ${file}`, 4);
  }
  if (!Array.isArray(res)) die("screen file needs a results array", 4);
  mkdirSync(COMPANY, { recursive: true });
  const excluded = [], research = [];
  for (const r of res) {
    const tf = join(TASKS, `${r?.id}.json`);
    if (!r?.id || !existsSync(tf)) continue;
    const task = readJson(tf);
    const ok = r.decision === "exclude" && !task.manual && /^https?:\/\//.test(String(r.source || "")) && String(r.reason || "").trim();
    if (!ok) {
      research.push(r.id);
      continue;
    }
    writeFileSync(join(COMPANY, `${r.id}.json`), JSON.stringify({
      exclude: true, screened: true, exclude_reason: String(r.reason).slice(0, 280), exclude_source: r.source,
      name: r.name || task.company, domain: r.domain || task.domain, segment: r.segment || r.reason, pain_points: [],
    }, null, 1));
    excluded.push(r.id);
  }
  console.log(`screen: ${excluded.length} excluded -> assemble and submit: ${excluded.join(" ") || "none"}`);
  console.log(`screen: ${research.length} to research -> company-researcher: ${research.join(" ") || "none"}`);
} else if (cmd === "assemble") {
  const id = pos[0];
  if (!id) die("usage: assemble <id>");
  const task = readJson(join(TASKS, `${id}.json`));
  const cf = join(COMPANY, `${id}.json`);
  if (!existsSync(cf)) die(`missing company file ${cf}: run company-researcher first`, 4);
  let company;
  try {
    company = readJson(cf);
  } catch (e) {
    die(`company file is not valid JSON (${e.message}); ask company-researcher to rewrite ${cf}`, 4);
  }
  const contacts = [];
  const missing = [];
  if (!(company.exclude === true && !task.manual)) {
    for (const p of task.people) {
      const f = join(CONTACTS, `${id}.${p.key}.json`);
      if (!existsSync(f)) {
        missing.push(p.key);
        continue;
      }
      try {
        contacts.push({ ...readJson(f), key: p.key });
      } catch (e) {
        missing.push(`${p.key} (invalid JSON: ${e.message})`);
      }
    }
  }
  if (missing.length) die(`missing or invalid contact files for: ${missing.join(", ")}; run contact-researcher for them`, 4);
  const companyBlock = company._cached ? { use_cached: true } : company;
  writeFileSync(join(RESULTS, `${id}.json`), JSON.stringify({ company: companyBlock, contacts }, null, 1));
  console.log(`assembled  ${id}  company ${company.exclude ? "excluded" : "ok"}, ${contacts.length} contact(s)`);
} else if (cmd === "submit") {
  const id = pos[0];
  if (!id) die("usage: submit <id> [result.json]");
  const file = pos[1] || join(RESULTS, `${id}.json`);
  if (!existsSync(file)) die(`no result file at ${file}`);
  let result;
  try {
    result = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    die(`retry: ${file} is not valid JSON (${e.message}). Rewrite it as one JSON object.`, 3);
  }
  const { status, data } = await call({ action: "submit", id, result });
  if (status === 200 && data.ok) {
    console.log(`ok  ${id}  ${data.leads ?? 0} lead(s) written${data.excluded?.length ? `, excluded ${data.excluded.join(",")}` : ""}${data.note ? `  (${data.note})` : ""}`);
    cleanup(id);
  } else if (status === 422 && !data.retry) {
    console.log(`closed  ${id}  rejected after 3 submits; move on`);
    cleanup(id);
    process.exit(2);
  } else if (status === 422 && data.retry) {
    console.log(`retry  ${id}  submits left: ${data.submits_left ?? "?"}`);
    for (const [k, list] of Object.entries(data.problems || {})) for (const p of list) console.log(`  - ${k}: ${p}`);
    process.exit(3);
  } else {
    die(`error  ${id}  (${status}) ${data.error || JSON.stringify(data).slice(0, 300)}`, 2);
  }
} else if (cmd === "release") {
  const id = pos[0];
  if (!id) die("usage: release <id> [reason] [--give-up]");
  const { status, data } = await call({ action: "release", id, reason: pos[1] || "released by worker", give_up: !!flags["give-up"] });
  if (status !== 200) die(`release failed (${status}): ${data.error}`);
  console.log(`released  ${id}  -> ${data.status}`);
  cleanup(id);
} else {
  die("commands: status | claim [n] [--kinds=...] | assemble <id> | submit <id> [file] | release <id> [reason] [--give-up]");
}
