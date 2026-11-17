#!/usr/bin/env bash
# Installs the node definitions of a specific n8n release so check.js can validate workflow JSON against them.
# Usage: ./setup.sh [n8n version]   (default 2.48.4)
set -euo pipefail
cd "$(dirname "$0")"
N8N_VERSION="${1:-2.48.4}"
deps=$(npm view "n8n@${N8N_VERSION}" dependencies --json)
pick() { echo "$deps" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)['$1']))"; }
NB=$(pick n8n-nodes-base); LC=$(pick @n8n/n8n-nodes-langchain); WF=$(pick n8n-workflow); CORE=$(pick n8n-core)
echo "n8n ${N8N_VERSION}: nodes-base ${NB}, nodes-langchain ${LC}, workflow ${WF}, core ${CORE}"

rm -rf nb lc node_modules package.json package-lock.json ./*.tgz
npm pack "n8n-nodes-base@${NB}" "@n8n/n8n-nodes-langchain@${LC}" --silent >/dev/null
mkdir -p nb lc
tar xzf "n8n-nodes-base-${NB}.tgz" -C nb
tar xzf "n8n-n8n-nodes-langchain-${LC}.tgz" -C lc
rm -f ./*.tgz

# Dependencies of both packages, minus SheetJS (served from its own CDN and not needed to read node definitions).
node -e "
const nb=require('./nb/package/package.json').dependencies||{};
const lc=require('./lc/package/package.json').dependencies||{};
const keep=(o,f)=>Object.fromEntries(Object.entries(o).filter(([k,v])=>!k.includes('xlsx')&&!String(v).startsWith('workspace')&&f(k)));
const LC_NEEDED=['@langchain/anthropic','@langchain/classic','@langchain/core','langchain','zod','zod-to-json-schema','@n8n/ai-utilities','@n8n/json-schema-to-zod','@n8n/di','@n8n/config','@n8n/utils'];
const lcNeeded=k=>LC_NEEDED.includes(k);
const deps={...keep(nb,()=>true),...keep(lc,lcNeeded),'n8n-workflow':'${WF}','n8n-core':'${CORE}'};
for (const k of Object.keys(deps)) if (k.startsWith('@n8n/typescript-config')||k==='@n8n/typeorm') delete deps[k];
require('fs').writeFileSync('package.json',JSON.stringify({name:'n8n-schema-check',private:true,dependencies:deps},null,1));
"
npm install --no-audit --no-fund --loglevel=error --ignore-scripts --legacy-peer-deps
echo "Ready: node check.js path/to/workflow.json ..."
