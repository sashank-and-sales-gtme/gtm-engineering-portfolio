"""Static validation for the generated n8n workflow."""
import json
import re
import subprocess
import sys
import tempfile

wf = json.load(open(sys.argv[1]))
names = [n["name"] for n in wf["nodes"]]
problems = []

# unique names / ids
if len(names) != len(set(names)):
    problems.append("duplicate node names")
if len({n["id"] for n in wf["nodes"]}) != len(names):
    problems.append("duplicate node ids")

# connections reference real nodes
incoming = {n: 0 for n in names}
for src, kinds in wf["connections"].items():
    if src not in names:
        problems.append(f"connection source missing: {src}")
    for kind, outs in kinds.items():
        for branch in outs:
            for c in branch:
                if c["node"] not in names:
                    problems.append(f"connection target missing: {src} -> {c['node']}")
                incoming[c["node"]] = incoming.get(c["node"], 0) + 1

triggers = {"n8n-nodes-base.webhook", "n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.formTrigger"}
models = {"@n8n/n8n-nodes-langchain.lmChatAnthropic"}
for n in wf["nodes"]:
    if n["type"] in triggers:
        continue
    if n["type"] in models:
        if n["name"] not in wf["connections"]:
            problems.append(f"model not attached: {n['name']}")
        continue
    if incoming.get(n["name"], 0) == 0:
        problems.append(f"orphan node (no input): {n['name']}")

# every extractor has a model
for n in wf["nodes"]:
    if n["type"].endswith("informationExtractor"):
        attached = any(c["node"] == n["name"]
                       for k in wf["connections"].values()
                       for b in k.get("ai_languageModel", []) for c in b)
        if not attached:
            problems.append(f"extractor without model: {n['name']}")

raw = json.dumps(wf)
# $('Node') references
for ref in set(re.findall(r"\$\('([^']+)'\)", raw)):
    if ref not in names:
        problems.append(f"expression references missing node: {ref}")

# secret scan
for pat, label in [(r"Bearer [A-Za-z0-9_-]{20,}", "bearer token"), (r"X-Api-Key", "inline api key header"),
                   (r"sk-ant-[A-Za-z0-9_-]{10,}", "anthropic key"), (r"xox[bpa]-[0-9]", "slack token"),
                   (r"eyJhbGciOi[A-Za-z0-9_-]{20,}", "inline JWT"), (r"file:///", "local file path"),
                   (r"gemini-1\.5", "retired model"), (r"journey_stage\[0\]", "character-index bug")]:
    if re.search(pat, raw):
        problems.append(f"found {label}")

# alwaysOutputData on IF nodes
for n in wf["nodes"]:
    if n["type"] == "n8n-nodes-base.if" and n.get("alwaysOutputData"):
        problems.append(f"alwaysOutputData on IF: {n['name']}")

# disabled nodes
for n in wf["nodes"]:
    if n.get("disabled"):
        problems.append(f"disabled node: {n['name']}")

# JS syntax: code nodes and expressions
snippets = []
for n in wf["nodes"]:
    if n["type"] == "n8n-nodes-base.code":
        snippets.append((n["name"] + " [code]", "(async function(){\n" + n["parameters"]["jsCode"] + "\n})"))

def walk(obj, path):
    if isinstance(obj, dict):
        for k, v in obj.items():
            walk(v, path + "." + k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            walk(v, f"{path}[{i}]")
    elif isinstance(obj, str) and obj.startswith("="):
        for m in re.finditer(r"\{\{(.*?)\}\}(?!\})", obj[1:], re.S):
            snippets.append((path, "(function(){ return (" + m.group(1) + "); })"))

for n in wf["nodes"]:
    walk(n["parameters"], n["name"])

js = "const vm=require('vm');const s=" + json.dumps(snippets) + ";let bad=0;for(const [p,c] of s){try{new vm.Script(c)}catch(e){bad++;console.log('SYNTAX',p,e.message)}}console.log('checked',s.length,'snippets, bad:',bad);"
with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
    f.write(js)
out = subprocess.run(["node", f.name], capture_output=True, text=True)
print(out.stdout.strip(), out.stderr.strip())
if "bad: 0" not in out.stdout:
    problems.append("JS syntax errors")

# schemas parse
for n in wf["nodes"]:
    if n["type"].endswith("informationExtractor"):
        json.loads(n["parameters"]["inputSchema"])
        if "{" in n["parameters"]["options"]["systemPromptTemplate"]:
            problems.append(f"curly brace in system prompt (LangChain template risk): {n['name']}")

print(f"{len(names)} nodes")
print("PROBLEMS:" if problems else "OK: no problems found")
for p in problems:
    print(" -", p)
