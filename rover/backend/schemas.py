from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=72)


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=10, max_length=72)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    is_active: bool
    mfa_enabled: bool
    created_at: datetime
    last_login: Optional[datetime] = None


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class MFASetup(BaseModel):
    secret: str
    otpauth_uri: str
    qr_code_png_base64: str


class MFACode(BaseModel):
    code: str = Field(min_length=6, max_length=8)


class ProviderOut(BaseModel):
    name: str
    label: str
    category: str
    configured: bool
    connected: bool


class AuthorizeOut(BaseModel):
    authorization_url: str


class CallbackIn(BaseModel):
    code: str
    state: str


class CredentialOut(BaseModel):
    """What the browser is allowed to see. Tokens never leave the server."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    provider: str
    scope: Optional[str] = None
    provider_account: Optional[str] = None
    expires_at: Optional[datetime] = None
    n8n_credential_id: Optional[str] = None
    n8n_credential_type: Optional[str] = None
    n8n_sync_error: Optional[str] = None
    created_at: datetime
