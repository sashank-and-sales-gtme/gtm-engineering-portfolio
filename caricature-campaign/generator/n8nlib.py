"""Small helper library for generating n8n workflow JSON."""
import json
import uuid


def nid():
    return str(uuid.uuid4())


CFG = "$('Load Config').first().json"


class WF:
    def __init__(self, name, timezone="America/Los_Angeles"):
        self.name = name
        self.nodes = []
        self.connections = {}
        self.timezone = timezone

    # ---------------------------------------------------------------- core
    def add(self, name, ntype, version, params, pos, **extra):
        node = {"parameters": params, "type": ntype, "typeVersion": version,
                "position": pos, "id": nid(), "name": name}
        node.update(extra)
        self.nodes.append(node)
        return name

    def link(self, src, dst, out=0, inp=0, kind="main"):
        outs = self.connections.setdefault(src, {}).setdefault(kind, [])
        while len(outs) <= out:
            outs.append([])
        outs[out].append({"node": dst, "type": kind, "index": inp})

    def chain(self, *names):
        for a, b in zip(names, names[1:]):
            self.link(a, b)

    def dump(self, path):
        wf = {"name": self.name, "nodes": self.nodes, "pinData": {}, "connections": self.connections,
              "active": False, "settings": {"executionOrder": "v1", "timezone": self.timezone}, "tags": []}
        with open(path, "w") as f:
            json.dump(wf, f, indent=2, ensure_ascii=False)
        return len(self.nodes)

    # ---------------------------------------------------------------- triggers
    def webhook(self, name, path, pos, method="POST", auth=True, respond_node=False):
        p = {"httpMethod": method, "path": path, "options": {}}
        if auth:
            p["authentication"] = "headerAuth"
        if respond_node:
            p["responseMode"] = "responseNode"
        return self.add(name, "n8n-nodes-base.webhook", 2, p, pos, webhookId=nid())

    def schedule(self, name, pos, hours_interval=None, at_hour=None, at_minute=0):
        if hours_interval:
            rule = {"interval": [{"field": "hours", "hoursInterval": hours_interval}]}
        else:
            rule = {"interval": [{"triggerAtHour": at_hour, "triggerAtMinute": at_minute}]}
        return self.add(name, "n8n-nodes-base.scheduleTrigger", 1.2, {"rule": rule}, pos)

    # ---------------------------------------------------------------- logic
    def code(self, name, pos, js, per_item=False):
        p = {"jsCode": js.strip()}
        if per_item:
            p["mode"] = "runOnceForEachItem"
        return self.add(name, "n8n-nodes-base.code", 2, p, pos)

    def if_bool(self, name, pos, expr, expect=True):
        cond = {"id": nid(), "leftValue": expr, "rightValue": "",
                "operator": {"type": "boolean", "operation": "true" if expect else "false", "singleValue": True}}
        return self.add(name, "n8n-nodes-base.if", 2.2, {
            "conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                           "conditions": [cond], "combinator": "and"}, "options": {}}, pos)

    def switch_expr(self, name, pos, n_outputs, expr):
        return self.add(name, "n8n-nodes-base.switch", 3.2,
                        {"mode": "expression", "numberOutputs": n_outputs, "output": expr}, pos)

    def noop(self, name, pos):
        return self.add(name, "n8n-nodes-base.noOp", 1, {}, pos)

    def stop(self, name, pos, message):
        return self.add(name, "n8n-nodes-base.stopAndError", 1, {"errorMessage": message}, pos)

    def merge(self, name, pos, n_inputs):
        return self.add(name, "n8n-nodes-base.merge", 3, {"numberInputs": n_inputs}, pos)

    def respond(self, name, pos, body, html=True):
        p = {"respondWith": "text", "responseBody": body, "options": {}}
        if html:
            p["options"] = {"responseHeaders": {"entries": [{"name": "Content-Type", "value": "text/html; charset=utf-8"}]}}
        return self.add(name, "n8n-nodes-base.respondToWebhook", 1.1, p, pos)

    def respond_json(self, name, pos, body_expr):
        return self.add(name, "n8n-nodes-base.respondToWebhook", 1.1,
                        {"respondWith": "json", "responseBody": body_expr, "options": {}}, pos)

    # ---------------------------------------------------------------- Supabase
    def sb_get(self, name, pos, table, filter_string=None, always=False):
        p = {"resource": "row", "operation": "getAll", "tableId": table, "returnAll": True}
        if filter_string:
            p.update({"filterType": "string", "filterString": filter_string})
        else:
            p.update({"filterType": "manual", "matchType": "allFilters", "filters": {}})
        kw = {"alwaysOutputData": True} if always else {}
        return self.add(name, "n8n-nodes-base.supabase", 1, p, pos, **kw)

    def sb_create(self, name, pos, table, on_error=False):
        p = {"resource": "row", "operation": "create", "tableId": table, "dataToSend": "autoMapInputData"}
        kw = {"onError": "continueRegularOutput"} if on_error else {}
        return self.add(name, "n8n-nodes-base.supabase", 1, p, pos, **kw)

    def sb_update(self, name, pos, table, id_expr="={{ $json.id }}"):
        p = {"resource": "row", "operation": "update", "tableId": table,
             "filterType": "manual", "matchType": "allFilters",
             "filters": {"conditions": [{"keyName": "id", "condition": "eq", "keyValue": id_expr}]},
             "dataToSend": "autoMapInputData"}
        return self.add(name, "n8n-nodes-base.supabase", 1, p, pos)

    def load_config(self, pos):
        return self.sb_get("Load Config", pos, "campaign_config")

    # ---------------------------------------------------------------- HTTP
    def http(self, name, pos, method, url, *, cred=None, body=None, query=None, on_error=False, **extra):
        p = {"method": method, "url": url}
        if cred == "hubspot":
            p.update({"authentication": "predefinedCredentialType", "nodeCredentialType": "hubspotAppToken"})
        elif cred == "header":
            p.update({"authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth"})
        if query:
            p["sendQuery"] = True
            p["queryParameters"] = {"parameters": [{"name": k, "value": v} for k, v in query]}
        if body is not None:
            p.update({"sendBody": True, "specifyBody": "json", "jsonBody": body})
        p["options"] = {}
        kw = dict(extra)
        if on_error:
            kw["onError"] = "continueRegularOutput"
        return self.add(name, "n8n-nodes-base.httpRequest", 4.2, p, pos, **kw)

    def hs_note(self, prefix, pos, contact_expr, body_expr):
        """Create a HubSpot note and associate it to the contact. Returns (first, last) node names."""
        x, y = pos
        a = self.http(f"{prefix}: Create Note", [x, y], "POST", "https://api.hubapi.com/crm/v3/objects/notes",
                      cred="hubspot", on_error=True,
                      body="={{ JSON.stringify({ properties: { hs_timestamp: $now.toISO(), hs_note_body: " + body_expr + " } }) }}")
        b = self.http(f"{prefix}: Link Note", [x + 220, y], "PUT",
                      "=https://api.hubapi.com/crm/v4/objects/notes/{{ $json.id }}/associations/default/contacts/{{ " + contact_expr + " }}",
                      cred="hubspot", on_error=True)
        self.link(a, b)
        return a, b

    def hs_task(self, prefix, pos, contact_expr, subject_expr, body_expr):
        x, y = pos
        owner = CFG + ".hubspot_owner_id"
        a = self.http(f"{prefix}: Create Task", [x, y], "POST", "https://api.hubapi.com/crm/v3/objects/tasks",
                      cred="hubspot", on_error=True,
                      body=("={{ JSON.stringify({ properties: Object.assign({ hs_timestamp: $now.plus({ hours: 2 }).toUTC().toISO(),"
                            " hs_task_subject: " + subject_expr + ", hs_task_body: " + body_expr + ","
                            " hs_task_status: 'NOT_STARTED', hs_task_priority: 'HIGH', hs_task_type: 'CALL' },"
                            " " + owner + " ? { hubspot_owner_id: " + owner + " } : {}) }) }}"))
        b = self.http(f"{prefix}: Link Task", [x + 220, y], "PUT",
                      "=https://api.hubapi.com/crm/v4/objects/tasks/{{ $json.id }}/associations/default/contacts/{{ " + contact_expr + " }}",
                      cred="hubspot", on_error=True)
        self.link(a, b)
        return a, b

    def slack(self, name, pos, text):
        return self.add(name, "n8n-nodes-base.slack", 2.3, {
            "authentication": "accessToken", "select": "channel",
            "channelId": {"__rl": True, "mode": "id", "value": "={{ " + CFG + ".slack_channel_id }}"},
            "text": text, "otherOptions": {"includeLinkToWorkflow": False}}, pos, webhookId=nid())

    # ---------------------------------------------------------------- AI
    def claude_extractor(self, name, pos, text, schema, system_prompt, max_tokens=2048):
        self.add(name, "@n8n/n8n-nodes-langchain.informationExtractor", 1, {
            "text": text, "schemaType": "manual", "inputSchema": json.dumps(schema, indent=2),
            "options": {"systemPromptTemplate": system_prompt}}, pos)
        model = f"Claude Model: {name}"
        self.add(model, "@n8n/n8n-nodes-langchain.lmChatAnthropic", 1.3, {
            "model": {"__rl": True, "mode": "list", "value": "claude-sonnet-5-5", "cachedResultName": "Claude Sonnet 5.5"},
            "options": {"maxTokensToSample": max_tokens, "temperature": 0.3}}, [pos[0], pos[1] + 220])
        self.link(model, name, kind="ai_languageModel")
        return name
