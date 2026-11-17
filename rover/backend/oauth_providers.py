"""OAuth 2.0 adapters for the CRMs and chat tools a GTM workflow writes to.

Each adapter knows its endpoints, default scopes, how to read the connected account, and which n8n
credential type receives the tokens. Client IDs and secrets come from the environment
(<PROVIDER>_CLIENT_ID / <PROVIDER>_CLIENT_SECRET); a provider without them is listed as not configured.
"""
import os
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException

from config import settings

TIMEOUT = httpx.Timeout(20.0)


@dataclass(frozen=True)
class Provider:
    name: str
    label: str
    category: str
    auth_url: str
    token_url: str
    scopes: tuple[str, ...]
    n8n_credential_type: str
    extra_auth_params: dict[str, str] = field(default_factory=dict)
    scope_param: str = "scope"
    account_reader: Callable[["Provider", dict], Any] | None = None

    @property
    def client_id(self) -> str:
        return os.getenv(f"{self.name.upper()}_CLIENT_ID", "")

    @property
    def client_secret(self) -> str:
        return os.getenv(f"{self.name.upper()}_CLIENT_SECRET", "")

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    def authorization_url(self, state: str) -> str:
        params = {"client_id": self.client_id, "redirect_uri": settings.oauth_redirect_uri, "response_type": "code",
                  self.scope_param: " ".join(self.scopes), "state": state, **self.extra_auth_params}
        return f"{self.auth_url}?{urlencode(params)}"

    async def exchange_code(self, code: str) -> dict:
        data = {"grant_type": "authorization_code", "code": code, "redirect_uri": settings.oauth_redirect_uri,
                "client_id": self.client_id, "client_secret": self.client_secret}
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(self.token_url, data=data, headers={"Accept": "application/json"})
        try:
            body = resp.json()
        except ValueError:
            body = {}
        if resp.status_code >= 400 or body.get("ok") is False or "error" in body and "access_token" not in body:
            reason = body.get("error_description") or body.get("error") or resp.text[:200]
            raise HTTPException(400, f"{self.label} rejected the authorization code: {reason}")
        return body

    async def read_account(self, tokens: dict) -> dict:
        """Returns {'account': str, 'metadata': dict} describing what was connected."""
        if self.account_reader is None:
            return {"account": None, "metadata": {}}
        try:
            return await self.account_reader(self, tokens)
        except httpx.HTTPError:
            return {"account": None, "metadata": {}}


async def _get_json(url: str, headers: dict) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(url, headers=headers)
    resp.raise_for_status()
    return resp.json()


async def _hubspot_account(p: Provider, tokens: dict) -> dict:
    info = await _get_json(f"https://api.hubapi.com/oauth/v1/access-tokens/{tokens['access_token']}", {})
    return {"account": f"{info.get('hub_domain') or 'portal'} ({info.get('hub_id')})",
            "metadata": {"hub_id": info.get("hub_id"), "user": info.get("user")}}


async def _salesforce_account(p: Provider, tokens: dict) -> dict:
    info = await _get_json("https://login.salesforce.com/services/oauth2/userinfo",
                           {"Authorization": f"Bearer {tokens['access_token']}"})
    return {"account": info.get("email"),
            "metadata": {"organization_id": info.get("organization_id"), "instance_url": tokens.get("instance_url")}}


async def _zoho_account(p: Provider, tokens: dict) -> dict:
    info = await _get_json(f"{settings.zoho_accounts_url}/oauth/user/info",
                           {"Authorization": f"Zoho-oauthtoken {tokens['access_token']}"})
    return {"account": info.get("Email"), "metadata": {"api_domain": tokens.get("api_domain")}}


async def _slack_account(p: Provider, tokens: dict) -> dict:
    team = tokens.get("team") or {}
    return {"account": team.get("name"),
            "metadata": {"team_id": team.get("id"), "bot_user_id": tokens.get("bot_user_id")}}


async def _microsoft_account(p: Provider, tokens: dict) -> dict:
    info = await _get_json("https://graph.microsoft.com/v1.0/me", {"Authorization": f"Bearer {tokens['access_token']}"})
    return {"account": info.get("mail") or info.get("userPrincipalName"), "metadata": {"id": info.get("id")}}


PROVIDERS: dict[str, Provider] = {
    "hubspot": Provider(
        name="hubspot", label="HubSpot", category="crm",
        auth_url="https://app.hubspot.com/oauth/authorize", token_url="https://api.hubapi.com/oauth/v1/token",
        scopes=("oauth", "crm.objects.contacts.read", "crm.objects.contacts.write",
                "crm.objects.companies.read", "crm.objects.companies.write"),
        n8n_credential_type="hubspotOAuth2Api", account_reader=_hubspot_account),
    "salesforce": Provider(
        name="salesforce", label="Salesforce", category="crm",
        auth_url="https://login.salesforce.com/services/oauth2/authorize",
        token_url="https://login.salesforce.com/services/oauth2/token",
        scopes=("api", "refresh_token", "openid", "email"),
        n8n_credential_type="salesforceOAuth2Api", account_reader=_salesforce_account),
    "zoho": Provider(
        name="zoho", label="Zoho CRM", category="crm",
        auth_url=f"{settings.zoho_accounts_url}/oauth/v2/auth", token_url=f"{settings.zoho_accounts_url}/oauth/v2/token",
        scopes=("ZohoCRM.modules.ALL", "ZohoCRM.users.READ", "AaaServer.profile.Read"),
        extra_auth_params={"access_type": "offline", "prompt": "consent"},
        n8n_credential_type="zohoOAuth2Api", account_reader=_zoho_account),
    "slack": Provider(
        name="slack", label="Slack", category="chat",
        auth_url="https://slack.com/oauth/v2/authorize", token_url="https://slack.com/api/oauth.v2.access",
        scopes=("chat:write", "channels:read", "users:read"),
        n8n_credential_type="slackApi", account_reader=_slack_account),
    "teams": Provider(
        name="teams", label="Microsoft Teams", category="chat",
        auth_url="https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_url="https://login.microsoftonline.com/common/oauth2/v2.0/token",
        scopes=("offline_access", "openid", "email", "User.Read", "Team.ReadBasic.All",
                "Channel.ReadBasic.All", "ChannelMessage.Send"),
        n8n_credential_type="microsoftTeamsOAuth2Api", account_reader=_microsoft_account),
}


def get_provider(name: str) -> Provider:
    provider = PROVIDERS.get(name)
    if provider is None:
        raise HTTPException(404, f"Unknown provider: {name}")
    if not provider.configured:
        raise HTTPException(400, f"{provider.label} is not configured on this server.")
    return provider
