"""Runtime configuration. Every secret comes from the environment; nothing sensitive has a default."""
import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


def _list(name: str, default: str) -> list[str]:
    return [v.strip() for v in os.getenv(name, default).split(",") if v.strip()]


@dataclass(frozen=True)
class Settings:
    secret_key: str = field(default_factory=lambda: os.getenv("SECRET_KEY", ""))
    token_encryption_key: str = field(default_factory=lambda: os.getenv("TOKEN_ENCRYPTION_KEY", ""))
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", "sqlite:///./rover.db"))
    access_token_minutes: int = field(default_factory=lambda: int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30")))
    max_failed_logins: int = 5
    lockout_minutes: int = 30
    cors_origins: list[str] = field(default_factory=lambda: _list("CORS_ORIGINS", "http://localhost:3000"))
    frontend_url: str = field(default_factory=lambda: os.getenv("FRONTEND_URL", "http://localhost:3000").rstrip("/"))
    n8n_api_url: str = field(default_factory=lambda: os.getenv("N8N_API_URL", "").rstrip("/"))
    n8n_api_key: str = field(default_factory=lambda: os.getenv("N8N_API_KEY", ""))
    zoho_accounts_url: str = field(default_factory=lambda: os.getenv("ZOHO_ACCOUNTS_URL", "https://accounts.zoho.com").rstrip("/"))

    @property
    def oauth_redirect_uri(self) -> str:
        return f"{self.frontend_url}/oauth/callback"

    @property
    def n8n_enabled(self) -> bool:
        return bool(self.n8n_api_url and self.n8n_api_key)

    def validate(self) -> None:
        missing = [name for name, value in (("SECRET_KEY", self.secret_key), ("TOKEN_ENCRYPTION_KEY", self.token_encryption_key)) if not value]
        if missing:
            raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}. See .env.example.")
        if len(self.secret_key) < 32:
            raise RuntimeError("SECRET_KEY must be at least 32 characters.")


settings = Settings()
