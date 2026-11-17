// Validates workflow JSON against real n8n node definitions (n8n-nodes-base / n8n-nodes-langchain 2.48.3).
const fs = require('fs');
const path = require('path');

const PKGS = {
  'n8n-nodes-base': path.resolve(__dirname, 'nb/package'),
  '@n8n/n8n-nodes-langchain': path.resolve(__dirname, 'lc/package'),
};
const index = {};
for (const [prefix, dir] of Object.entries(PKGS)) {
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const rel of pj.n8n.nodes) {
    const base = path.basename(rel).replace(/\.node\.js$/, '');
    index[`${prefix}.${base[0].toLowerCase()}${base.slice(1)}`] = path.join(dir, rel);
  }
}

const cache = {};
function describe(type, version) {
  const key = `${type}@${version}`;
  if (key in cache) return cache[key];
  let file = index[type];
  if (!file) {
    // node class name and type name can differ in case; search loosely
    const want = type.split('.').pop().toLowerCase();
    const hit = Object.keys(index).find((k) => k.split('.').pop().toLowerCase() === want && k.startsWith(type.split('.').slice(0, -1).join('.')));
    file = hit && index[hit];
  }
  if (!file) return (cache[key] = { error: 'node type not found in package' });
  try {
    const mod = require(file);
    const Cls = Object.values(mod).find((v) => typeof v === 'function');
    const inst = new Cls();
    if (inst.nodeVersions) {
      const versions = Object.keys(inst.nodeVersions).map(Number);
      const d = inst.nodeVersions[version];
      if (!d) return (cache[key] = { error: `typeVersion ${version} not supported (has ${versions.join(', ')})` });
      return (cache[key] = { desc: { ...inst.description, ...d.description } });
    }
    const v = inst.description.version;
    const vs = Array.isArray(v) ? v : [v];
    if (!vs.includes(version)) return (cache[key] = { error: `typeVersion ${version} not supported (has ${vs.join(', ')})` });
    return (cache[key] = { desc: inst.description });
  } catch (e) {
    return (cache[key] = { error: `could not load: ${e.message.split('\n')[0]}` });
  }
}

function checkParams(params, props, where, problems) {
  const byName = {};
  for (const p of props) (byName[p.name] = byName[p.name] || []).push(p);
  for (const [k, v] of Object.entries(params)) {
    const defs = byName[k];
    if (!defs) { problems.push(`${where}: unknown parameter "${k}"`); continue; }
    const isExpr = typeof v === 'string' && v.startsWith('=');
    const optionDefs = defs.filter((d) => d.type === 'options' && Array.isArray(d.options));
    if (optionDefs.length && !isExpr && typeof v !== 'object') {
      const ok = optionDefs.some((d) => d.options.some((o) => o.value === v));
      if (!ok) problems.push(`${where}: "${k}" = ${JSON.stringify(v)} not in [${optionDefs.flatMap((d) => d.options.map((o) => o.value)).join(', ')}]`);
    }
    // collections: check child names one level down
    const coll = defs.find((d) => d.type === 'collection' && Array.isArray(d.options));
    if (coll && v && typeof v === 'object' && !Array.isArray(v)) {
      checkParams(v, coll.options, `${where}.${k}`, problems);
    }
    const fixed = defs.find((d) => d.type === 'fixedCollection' && Array.isArray(d.options));
    if (fixed && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [gk, gv] of Object.entries(v)) {
        const group = fixed.options.find((o) => o.name === gk);
        if (!group) { problems.push(`${where}.${k}: unknown group "${gk}"`); continue; }
        const rows = Array.isArray(gv) ? gv : [gv];
        rows.forEach((row, i) => row && typeof row === 'object' && checkParams(row, group.values || [], `${where}.${k}.${gk}[${i}]`, problems));
      }
    }
  }
}

let total = 0;
for (const f of process.argv.slice(2)) {
  const wf = JSON.parse(fs.readFileSync(f, 'utf8'));
  const problems = [];
  for (const n of wf.nodes) {
    const r = describe(n.type, n.typeVersion);
    if (r.error) { problems.push(`${n.name} [${n.type}@${n.typeVersion}]: ${r.error}`); continue; }
    checkParams(n.parameters || {}, r.desc.properties || [], `${n.name}`, problems);
    if (n.credentials) {
      const allowed = (r.desc.credentials || []).map((c) => c.name);
      for (const c of Object.keys(n.credentials)) if (allowed.length && !allowed.includes(c)) problems.push(`${n.name}: credential "${c}" not accepted (${allowed.join(', ')})`);
    }
  }
  total += problems.length;
  console.log(`\n== ${path.basename(f)}: ${problems.length ? problems.length + ' problem(s)' : 'OK'}`);
  problems.forEach((p) => console.log('  - ' + p));
}
console.log(`\nTOTAL PROBLEMS: ${total}`);
