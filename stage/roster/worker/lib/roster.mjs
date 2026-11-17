// HTTP client for the roster's claude-work function: the same status / claim / submit / release protocol the
// Claude Code worker uses (roster-worker.mjs), for the API worker.

export class RosterError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function rosterClient({ url, token, worker }) {
  if (!url) throw new Error("Set ROSTER_WORKER_URL (Admin > Integrations > Claude worker shows it).");
  if (!token) throw new Error("Set ROSTER_WORKER_TOKEN (create one in Admin > Integrations > Claude worker).");

  async function call(body) {
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ worker, ...body }),
          signal: AbortSignal.timeout(60000),
        });
        if (res.status >= 500 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        break;
      } catch (e) {
        if (attempt === 2) throw new RosterError(`Network error: ${e.message}`, 0, null);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: text.slice(0, 300) };
    }
    return { status: res.status, data };
  }

  const must = async (body) => {
    const { status, data } = await call(body);
    if (status !== 200) throw new RosterError(`${body.action} failed (${status}): ${data.error ?? "unknown error"}`, status, data);
    return data;
  };

  return {
    status: () => must({ action: "status" }),
    claim: (n, kinds) => must({ action: "claim", n, kinds }),
    /** Returns {ok, retry, problems, submits_left, ...} and the HTTP status; never throws on a 422. */
    submit: async (id, result, usage) => {
      const { status, data } = await call({ action: "submit", id, result, usage });
      if (status === 200 || status === 422) return { status, ...data };
      throw new RosterError(`submit ${id} failed (${status}): ${data.error ?? "unknown error"}`, status, data);
    },
    release: (id, reason, giveUp = false, usage) => must({ action: "release", id, reason: String(reason).slice(0, 300), give_up: giveUp, usage }),
  };
}
