"""Hands connected OAuth tokens to n8n as credentials through n8n's public API.

The payload is checked against n8n's own schema for the credential type
(GET /api/v1/credentials/schema/{type}) before creation, so a mismatch fails with a clear message
instead of an opaque validation error. For OAuth2 credential types n8n refreshes the tokens itself
after the handoff, using the client ID and secret included here.
"""
import asyncio
import logging
from typing import Any

import httpx

from config import settings
from oauth_providers import Provider

log = logging.getLogger("rover.n8n")


class N8nSyncError(Exception):
    pass


class N8nClient:
    def __init__(self, base_url: str | None = None, api_key: str | None = None):
        self.base_url = (base_url or settings.n8n_api_url).rstrip("/")
        self.headers = {"X-N8N-API-KEY": api_key or settings.n8n_api_key, "Accept": "application/json"}

    async def _request(self, method: str, path: str, *, json: Any = None, retries: int = 3) -> httpx.Response:
        last: Exception | None = None
        for attempt in range(retries):
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(20.0)) as client:
                    resp = await client.request(method, f"{self.base_url}/api/v1{path}", headers=self.headers, json=json)
                if resp.status_code >= 500:
                    raise httpx.HTTPStatusError("n8n server error", request=resp.request, response=resp)
                return resp
            except httpx.HTTPError as exc:
                last = exc
                log.warning("n8n %s %s failed (attempt %s): %s", method, path, attempt + 1, exc)
                await asyncio.sleep(0.5 * 2 ** attempt)
        raise N8nSyncError(f"n8n unreachable: {last}")

    async def schema(self, credential_type: str) -> dict:
        resp = await self._request("GET", f"/credentials/schema/{credential_type}")
        if resp.status_code != 200:
            raise N8nSyncError(f"n8n has no credential type '{credential_type}' ({resp.status_code}).")
        return resp.json()

    async def create_credential(self, name: str, credential_type: str, data: dict) -> str:
        resp = await self._request("POST", "/credentials", json={"name": name, "type": credential_type, "data": data})
        if resp.status_code not in (200, 201):
            raise N8nSyncError(f"n8n rejected the credential ({resp.status_code}): {resp.text[:300]}")
        return str(resp.json()["id"])

    async def delete_credential(self, credential_id: str) -> None:
        resp = await self._request("DELETE", f"/credentials/{credential_id}")
        if resp.status_code not in (200, 204, 404):
            raise N8nSyncError(f"n8n could not delete credential {credential_id} ({resp.status_code}).")


def credential_payload(provider: Provider, tokens: dict) -> dict:
    """Builds the credential data n8n expects for each provider's credential type."""
    if provider.name == "slack":
        return {"accessToken": tokens["access_token"]}  # bot token; slackApi credentials take it directly
    token_data = {k: v for k, v in tokens.items() if k in (
        "access_token", "refresh_token", "token_type", "expires_in", "scope", "instance_url", "id_token", "api_domain")}
    payload: dict[str, Any] = {"clientId": provider.client_id, "clientSecret": provider.client_secret,
                               "oauthTokenData": token_data}
    if provider.name == "salesforce":
        payload["environment"] = "production"
    return payload


def fit_to_schema(payload: dict, schema: dict) -> dict:
    """Keeps only fields n8n's schema declares and fails if a required field is missing."""
    props = schema.get("properties") or {}
    fitted = {k: v for k, v in payload.items() if not props or k in props}
    missing = [k for k in schema.get("required") or [] if k not in fitted]
    if missing:
        raise N8nSyncError(f"n8n credential schema requires fields Rover does not supply: {', '.join(missing)}")
    return fitted


async def sync_credential(provider: Provider, tokens: dict, user_id: int, client: N8nClient | None = None) -> tuple[str, str]:
    client = client or N8nClient()
    schema = await client.schema(provider.n8n_credential_type)
    data = fit_to_schema(credential_payload(provider, tokens), schema)
    credential_id = await client.create_credential(f"rover:{user_id}:{provider.name}", provider.n8n_credential_type, data)
    return credential_id, provider.n8n_credential_type
