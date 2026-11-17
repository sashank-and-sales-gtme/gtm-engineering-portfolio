# n8n schema check

Validates workflow JSON against the real node definitions of a specific n8n release, before anything is imported:

- the node type exists and the `typeVersion` is supported
- every parameter name exists on that node version, including inside collections and fixed collections
- option values (for example `operation`, `filterType`, a form field's `fieldType`) are legal
- attached credentials are ones the node accepts

```bash
./setup.sh            # installs n8n 2.48.4's node packages (pass another version to target it)
node check.js ../../rover/workflows/*.json ../../caricature-campaign/workflows/*.json
```

Every workflow in this repository passes against n8n 2.48.4.
