import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRunner, echoable, extractJson, parseAgent } from "../lib/agents.mjs";

test("parseAgent splits frontmatter from instructions", () => {
  const { meta, body } = parseAgent('---\nname: prep-writer\ndescription: "Writes briefs"\ntools: Read, Write\n---\n\nYou write briefs.\n');
  assert.equal(meta.name, "prep-writer");
  assert.equal(meta.description, "Writes briefs");
  assert.equal(body, "You write briefs.");
});

test("extractJson reads bare, fenced and wrapped objects", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here it is: {"a":{"b":2}} done'), { a: { b: 2 } });
  assert.equal(extractJson("no json here"), undefined);
});

test("echoable drops what a declined model wrote before the fallback marker", () => {
  const content = [
    { type: "thinking", thinking: "" },
    { type: "server_tool_use", id: "s1" },
    { type: "web_search_tool_result", tool_use_id: "s1" },
    { type: "server_tool_use", id: "s2" },
    { type: "text", text: "partial" },
    { type: "fallback", from: { model: "a" }, to: { model: "b" } },
    { type: "thinking", thinking: "" },
    { type: "text", text: "after" },
  ];
  assert.deepEqual(echoable(content).map((b) => b.id ?? b.tool_use_id ?? b.text ?? b.type), ["s1", "s1", "partial", "thinking", "after"]);
  assert.equal(echoable(content.slice(0, 2)).length, 2);
});

function fakeClient(replies) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const next = replies.shift();
          return { finalMessage: async () => next };
        },
      },
    },
  };
}

const msg = (stop_reason, content, usage = { input_tokens: 10, output_tokens: 5 }) => ({ stop_reason, content, usage });

function agentsDir() {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  writeFileSync(join(dir, "company-researcher.md"), "---\nname: company-researcher\n---\nResearch the company.");
  return dir;
}

test("run resumes a paused turn, offers the web tools and returns the JSON", async () => {
  const client = fakeClient([
    msg("pause_turn", [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }], { input_tokens: 100, output_tokens: 20, server_tool_use: { web_search_requests: 1 } }),
    msg("end_turn", [{ type: "text", text: '{"name":"Acme","exclude":false}' }]),
  ]);
  const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0, calls: 0 };
  const { run } = agentRunner({ agentsDir: agentsDir(), model: "claude-opus-5-5", client });
  const out = await run("company-researcher", { ask: "Research it.", input: { "Task file": { id: "t1" }, Homepage: "https://acme.com" }, searches: 5, fetches: 1, usage });
  assert.deepEqual(out, { name: "Acme", exclude: false });
  assert.deepEqual(usage, { input_tokens: 110, output_tokens: 25, web_searches: 1, calls: 2 });
  const first = client.calls[0];
  assert.equal(first.model, "claude-opus-5-5");
  assert.deepEqual(first.tools.map((t) => [t.type, t.max_uses]), [["web_search_20260209", 5], ["web_fetch_20260209", 1]]);
  assert.equal(first.fallbacks, "default");
  assert.match(first.messages[0].content, /https:\/\/acme\.com/);
  assert.match(first.system[0].text, /^You run inside the roster's API worker/);
  // The paused turn goes back as is, with no extra user message.
  assert.equal(client.calls[1].messages.length, 2);
  assert.equal(client.calls[1].messages[1].role, "assistant");
});

test("run asks once more when the reply is not JSON, then gives up", async () => {
  const ok = fakeClient([msg("end_turn", [{ type: "text", text: "Sure!" }]), msg("end_turn", [{ type: "text", text: '{"a":1}' }])]);
  const r1 = agentRunner({ agentsDir: agentsDir(), model: "claude-opus-5-5", client: ok });
  assert.deepEqual(await r1.run("company-researcher", { ask: "x", input: {} }), { a: 1 });
  assert.equal(ok.calls[1].messages.at(-1).role, "user");
  assert.equal(ok.calls[0].tools, undefined);

  const bad = fakeClient([msg("end_turn", [{ type: "text", text: "no" }]), msg("end_turn", [{ type: "text", text: "still no" }])]);
  const r2 = agentRunner({ agentsDir: agentsDir(), model: "claude-opus-5-5", client: bad });
  await assert.rejects(r2.run("company-researcher", { ask: "x", input: {} }), /did not return a JSON object/);
});

test("run surfaces refusals and uses basic web tools on Haiku", async () => {
  const c = fakeClient([msg("refusal", [])]);
  c.calls.length = 0;
  const r = agentRunner({ agentsDir: agentsDir(), model: "claude-haiku-5-5", client: c });
  await assert.rejects(r.run("company-researcher", { ask: "x", input: {}, searches: 1 }), /declined/);
  assert.equal(c.calls[0].tools[0].type, "web_search_20250305");
  assert.equal(c.calls[0].fallbacks, undefined);
});
