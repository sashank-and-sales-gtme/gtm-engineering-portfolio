// Simulates a prospect's browsing to check which pixel events the snippet emits.
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync(process.argv[2], 'utf8');
const js = html.split('<script>')[1].split('</script>')[0];

const local = new Map();
let failures = 0;
function visit(url, sessionStore, clickDemo = false) {
  const sent = [];
  const u = new URL(url);
  const listeners = [];
  const storage = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) });
  const win = { location: { search: u.search, pathname: u.pathname }, localStorage: storage(local), sessionStorage: storage(sessionStore) };
  const sandbox = {
    window: win, URLSearchParams,
    Image: function () { return { set src(v) { const q = new URL(v).searchParams; sent.push(`${q.get('ev')}${q.get('first') === '1' ? '*' : ''}`); } }; },
    document: { addEventListener: (t, fn) => listeners.push(fn) },
  };
  vm.runInNewContext(js, sandbox);
  if (clickDemo) listeners.forEach((fn) => fn({ target: { closest: () => ({}) } }));
  if (clickDemo) listeners.forEach((fn) => fn({ target: { closest: () => ({}) } }));
  return sent.join(',');
}
const expect = (label, got, want) => {
  const pass = got === want;
  if (!pass) failures++;
  console.log(pass ? 'PASS' : 'FAIL', label, pass ? '' : `got ${got}, want ${want}`);
};

expect('anonymous visitor: nothing sent', visit('https://interactlabs.ai/pricing', new Map()), '');
const s1 = new Map();
expect('QR landing: qr + pv (no duplicate visit alert)', visit('https://interactlabs.ai/?utm_source=direct_mail&utm_medium=caricature_doll&utm_campaign=acme_outreach&utm_content=abc123def456', s1), 'qr,pv');
expect('next page same session: pv only', visit('https://interactlabs.ai/product', s1), 'pv');
expect('demo click twice: one demo event', visit('https://interactlabs.ai/product', s1, true), 'pv,demo');
expect('contact page in QR session: pv + lpc', visit('https://interactlabs.ai/contact', s1), 'pv,lpc');
expect('contact page again: no second lpc', visit('https://interactlabs.ai/contact', s1), 'pv');
const s2 = new Map();
expect('return visit days later (new session, no QR): first-in-session pv', visit('https://interactlabs.ai/', s2), 'pv*');
expect('contact page in non-QR session: no lpc', visit('https://interactlabs.ai/contact', s2), 'pv');
console.log(`FAILURES: ${failures}`);
