from urllib.parse import parse_qs, urlparse

import httpx
import respx
from sqlalchemy import text

from conftest import signup_and_login
from database import engine


def start(client, headers, provider):
    r = client.post(f"/oauth/{provider}/authorize", headers=headers)
    assert r.status_code == 200, r.text
    url = urlparse(r.json()["authorization_url"])
    q = parse_qs(url.query)
    assert q["redirect_uri"] == ["http://localhost:3000/oauth/callback"]
    return q["state"][0], url


def test_providers_listing_shows_configured(client):
    headers = signup_and_login(client)
    providers = {p["name"]: p for p in client.get("/oauth/providers", headers=headers).json()}
    assert providers["hubspot"]["configured"] and providers["slack"]["configured"]
    assert not providers["salesforce"]["configured"]
    assert client.post("/oauth/salesforce/authorize", headers=headers).status_code == 400


@respx.mock
def test_hubspot_connect_encrypts_tokens_and_syncs_to_n8n(client):
    headers = signup_and_login(client)
    state, url = start(client, headers, "hubspot")
    assert url.netloc == "app.hubspot.com"

    respx.post("https://api.hubapi.com/oauth/v1/token").mock(return_value=httpx.Response(200, json={
        "access_token": "hs-access-123", "refresh_token": "hs-refresh-456", "expires_in": 1800, "token_type": "bearer"}))
    respx.get("https://api.hubapi.com/oauth/v1/access-tokens/hs-access-123").mock(return_value=httpx.Response(200, json={
        "hub_id": 42, "hub_domain": "acme.com", "user": "ops@acme.com"}))
    schema = respx.get("http://n8n.test/api/v1/credentials/schema/hubspotOAuth2Api").mock(return_value=httpx.Response(200, json={
        "properties": {"clientId": {}, "clientSecret": {}, "oauthTokenData": {}}, "required": ["clientId", "clientSecret"]}))
    create = respx.post("http://n8n.test/api/v1/credentials").mock(return_value=httpx.Response(200, json={"id": "n8n-cred-1"}))

    r = client.post("/oauth/callback", json={"code": "abc", "state": state}, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n8n_credential_id"] == "n8n-cred-1" and body["n8n_credential_type"] == "hubspotOAuth2Api"
    assert body["provider_account"] == "acme.com (42)"
    assert "access_token" not in body and "refresh_token" not in body
    assert schema.called and create.called
    sent = create.calls.last.request.read().decode()
    assert '"name":"rover:1:hubspot"' in sent.replace(" ", "") and "hs-refresh-456" in sent

    with engine.connect() as conn:
        raw = conn.execute(text("select access_token from oauth_credentials")).scalar()
    assert raw and "hs-access-123" not in raw

    listed = client.get("/oauth/credentials", headers=headers).json()
    assert len(listed) == 1 and "access_token" not in listed[0]


@respx.mock
def test_slack_maps_bot_token_to_slack_api(client):
    headers = signup_and_login(client)
    state, _ = start(client, headers, "slack")
    respx.post("https://slack.com/api/oauth.v2.access").mock(return_value=httpx.Response(200, json={
        "ok": True, "access_token": "xoxb-bot", "bot_user_id": "U1", "team": {"id": "T1", "name": "Acme"}}))
    respx.get("http://n8n.test/api/v1/credentials/schema/slackApi").mock(return_value=httpx.Response(200, json={
        "properties": {"accessToken": {}}, "required": ["accessToken"]}))
    create = respx.post("http://n8n.test/api/v1/credentials").mock(return_value=httpx.Response(200, json={"id": "n8n-slack"}))
    r = client.post("/oauth/callback", json={"code": "c", "state": state}, headers=headers)
    assert r.status_code == 200 and r.json()["provider_account"] == "Acme"
    assert '"accessToken":"xoxb-bot"' in create.calls.last.request.read().decode().replace(" ", "")


@respx.mock
def test_slack_error_response_is_rejected(client):
    headers = signup_and_login(client)
    state, _ = start(client, headers, "slack")
    respx.post("https://slack.com/api/oauth.v2.access").mock(return_value=httpx.Response(200, json={"ok": False, "error": "invalid_code"}))
    r = client.post("/oauth/callback", json={"code": "c", "state": state}, headers=headers)
    assert r.status_code == 400 and "invalid_code" in r.json()["detail"]


@respx.mock
def test_n8n_schema_mismatch_is_reported_not_fatal(client):
    headers = signup_and_login(client)
    state, _ = start(client, headers, "slack")
    respx.post("https://slack.com/api/oauth.v2.access").mock(return_value=httpx.Response(200, json={
        "ok": True, "access_token": "xoxb", "team": {"name": "Acme"}}))
    respx.get("http://n8n.test/api/v1/credentials/schema/slackApi").mock(return_value=httpx.Response(200, json={
        "properties": {"accessToken": {}, "signatureSecret": {}}, "required": ["accessToken", "signatureSecret"]}))
    r = client.post("/oauth/callback", json={"code": "c", "state": state}, headers=headers)
    assert r.status_code == 200
    assert "signatureSecret" in r.json()["n8n_sync_error"] and r.json()["n8n_credential_id"] is None


def test_state_is_single_use_and_user_bound(client):
    alice = signup_and_login(client, "alice@example.com")
    bob = signup_and_login(client, "bob@example.com")
    state, _ = start(client, alice, "hubspot")
    assert client.post("/oauth/callback", json={"code": "c", "state": state}, headers=bob).status_code == 400
    assert client.post("/oauth/callback", json={"code": "c", "state": "forged"}, headers=alice).status_code == 400


@respx.mock
def test_disconnect_deletes_n8n_credential(client):
    headers = signup_and_login(client)
    state, _ = start(client, headers, "slack")
    respx.post("https://slack.com/api/oauth.v2.access").mock(return_value=httpx.Response(200, json={"ok": True, "access_token": "x", "team": {}}))
    respx.get("http://n8n.test/api/v1/credentials/schema/slackApi").mock(return_value=httpx.Response(200, json={"properties": {"accessToken": {}}}))
    respx.post("http://n8n.test/api/v1/credentials").mock(return_value=httpx.Response(200, json={"id": "n8n-9"}))
    cred_id = client.post("/oauth/callback", json={"code": "c", "state": state}, headers=headers).json()["id"]
    delete = respx.delete("http://n8n.test/api/v1/credentials/n8n-9").mock(return_value=httpx.Response(200, json={}))
    assert client.delete(f"/oauth/credentials/{cred_id}", headers=headers).status_code == 204
    assert delete.called
    assert client.get("/oauth/credentials", headers=headers).json() == []
