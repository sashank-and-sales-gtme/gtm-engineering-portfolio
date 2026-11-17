// HubSpot keeps the latest sales-email open, click and reply on each contact. Pure, so it can be tested.

// Sales-email tracking (sequences and 1:1 emails), with the marketing equivalents as a fallback.
export const EMAIL_SIGNAL_PROPS = [
  "hs_sales_email_last_opened", "hs_sales_email_last_clicked", "hs_sales_email_last_replied",
  "hs_email_last_open_date", "hs_email_last_click_date",
];

const ms = (v: unknown) => {
  if (!v) return NaN;
  const s = String(v);
  return /^\d+$/.test(s) ? Number(s) : new Date(s).getTime();
};

/** The latest open, click and reply times on a contact, as ISO strings. */
export function emailSignals(p: Record<string, string | null | undefined>): { opened?: string; clicked?: string; replied?: string } {
  const pick = (...keys: string[]) => {
    const ts = keys.map((k) => ms(p[k])).filter((t) => !isNaN(t));
    return ts.length ? new Date(Math.max(...ts)).toISOString() : undefined;
  };
  const out: { opened?: string; clicked?: string; replied?: string } = {};
  const o = pick("hs_sales_email_last_opened", "hs_email_last_open_date");
  const c = pick("hs_sales_email_last_clicked", "hs_email_last_click_date");
  const r = pick("hs_sales_email_last_replied");
  if (o) out.opened = o;
  if (c) out.clicked = c;
  if (r) out.replied = r;
  return out;
}
