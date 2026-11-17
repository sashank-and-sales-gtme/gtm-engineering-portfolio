import json
import logging
import secrets
from datetime import timedelta
from typing import Optional

from fastapi import Depends, FastAPI, Form, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from auth import (create_access_token, get_current_user, hash_password, is_locked, new_mfa_setup,
                  register_failed_login, verify_password, verify_totp)
from config import settings
from database import Base, engine, get_db, utcnow
from models import AuditLog, OAuthCredential, OAuthState, User
from n8n_client import N8nClient, N8nSyncError, sync_credential
from oauth_providers import PROVIDERS, get_provider
from schemas import (AuthorizeOut, CallbackIn, CredentialOut, MFACode, MFASetup, PasswordChange, ProviderOut, Token,
                     UserCreate, UserOut)

settings.validate()
Base.metadata.create_all(bind=engine)
log = logging.getLogger("rover")

app = FastAPI(title="Rover", description="Connects a customer's CRM and chat tools to n8n through OAuth.")
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                   allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Authorization", "Content-Type"])


def audit(db: Session, request: Request, user_id: Optional[int], action: str, **details) -> None:
    db.add(AuditLog(user_id=user_id, action=action, ip_address=request.client.host if request.client else None,
                    user_agent=request.headers.get("user-agent"), details=details))
    db.commit()


# ---------------------------------------------------------------- users and sessions

@app.post("/users", response_model=UserOut, status_code=201)
def signup(body: UserCreate, request: Request, db: Session = Depends(get_db)):
    email = body.email.lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(400, "Email already registered")
    user = User(email=email, hashed_password=hash_password(body.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    audit(db, request, user.id, "signup")
    return user


@app.post("/token", response_model=Token)
def login(request: Request, form: OAuth2PasswordRequestForm = Depends(), mfa_code: Optional[str] = Form(None),
          db: Session = Depends(get_db)):
    bad = HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect email or password", headers={"WWW-Authenticate": "Bearer"})
    user = db.query(User).filter(User.email == form.username.lower()).first()
    if user is None:
        raise bad
    if is_locked(user):
        raise HTTPException(status.HTTP_423_LOCKED, "Account locked after repeated failed logins. Try again later.")
    if not verify_password(form.password, user.hashed_password):
        register_failed_login(user, db)
        audit(db, request, user.id, "login_failed", reason="password")
        raise bad
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account disabled")
    if user.mfa_enabled:
        if not mfa_code:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "mfa_required")
        if not verify_totp(user.mfa_secret, mfa_code):
            register_failed_login(user, db)
            audit(db, request, user.id, "login_failed", reason="mfa")
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid MFA code")
    user.failed_login_attempts = 0
    user.last_login = utcnow()
    db.commit()
    audit(db, request, user.id, "login")
    token, expires_in = create_access_token(user.email)
    return Token(access_token=token, expires_in=expires_in)


@app.get("/users/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@app.put("/users/me/password", status_code=204)
def change_password(body: PasswordChange, request: Request, user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    if not verify_password(body.current_password, user.hashed_password):
        raise HTTPException(400, "Current password is incorrect")
    user.hashed_password = hash_password(body.new_password)
    db.commit()
    audit(db, request, user.id, "password_changed")


# ---------------------------------------------------------------- MFA

@app.post("/mfa/setup", response_model=MFASetup)
def mfa_setup(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if user.mfa_enabled:
        raise HTTPException(400, "MFA is already enabled")
    secret, uri, png = new_mfa_setup(user.email)
    user.mfa_secret = secret
    db.commit()
    return MFASetup(secret=secret, otpauth_uri=uri, qr_code_png_base64=png)


@app.post("/mfa/enable", status_code=204)
def mfa_enable(body: MFACode, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not user.mfa_secret or not verify_totp(user.mfa_secret, body.code):
        raise HTTPException(400, "Invalid MFA code")
    user.mfa_enabled = True
    db.commit()
    audit(db, request, user.id, "mfa_enabled")


@app.post("/mfa/disable", status_code=204)
def mfa_disable(body: MFACode, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not user.mfa_enabled or not verify_totp(user.mfa_secret, body.code):
        raise HTTPException(400, "Invalid MFA code")
    user.mfa_enabled = False
    user.mfa_secret = None
    db.commit()
    audit(db, request, user.id, "mfa_disabled")


# ---------------------------------------------------------------- OAuth connections

@app.get("/oauth/providers", response_model=list[ProviderOut])
def list_providers(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    connected = {c.provider for c in db.query(OAuthCredential).filter(OAuthCredential.user_id == user.id)}
    return [ProviderOut(name=p.name, label=p.label, category=p.category, configured=p.configured,
                        connected=p.name in connected) for p in PROVIDERS.values()]


@app.post("/oauth/{provider_name}/authorize", response_model=AuthorizeOut)
def authorize(provider_name: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    provider = get_provider(provider_name)
    state = secrets.token_urlsafe(32)
    db.add(OAuthState(state=state, user_id=user.id, provider=provider.name, expires_at=utcnow() + timedelta(minutes=10)))
    db.commit()
    return AuthorizeOut(authorization_url=provider.authorization_url(state))


@app.post("/oauth/callback", response_model=CredentialOut)
async def oauth_callback(body: CallbackIn, request: Request, user: User = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    pending = db.query(OAuthState).filter(OAuthState.state == body.state).first()
    if pending is None or pending.user_id != user.id or pending.used or pending.expires_at < utcnow():
        raise HTTPException(400, "This authorization link is invalid or expired. Start the connection again.")
    pending.used = True
    db.commit()

    provider = get_provider(pending.provider)
    tokens = await provider.exchange_code(body.code)
    account = await provider.read_account(tokens)
    expires_in = tokens.get("expires_in")

    cred = db.query(OAuthCredential).filter(OAuthCredential.user_id == user.id,
                                            OAuthCredential.provider == provider.name).first()
    old_n8n_id = cred.n8n_credential_id if cred else None
    if cred is None:
        cred = OAuthCredential(user_id=user.id, provider=provider.name)
        db.add(cred)
    cred.access_token = tokens["access_token"]
    cred.refresh_token = tokens.get("refresh_token")
    cred.token_payload = json.dumps(tokens)
    cred.expires_at = utcnow() + timedelta(seconds=int(expires_in)) if expires_in else None
    cred.scope = tokens.get("scope") or " ".join(provider.scopes)
    cred.provider_account = account["account"]
    cred.provider_metadata = account["metadata"]
    cred.n8n_sync_error = None

    if settings.n8n_enabled:
        client = N8nClient()
        try:
            cred.n8n_credential_id, cred.n8n_credential_type = await sync_credential(provider, tokens, user.id, client)
            if old_n8n_id and old_n8n_id != cred.n8n_credential_id:
                await client.delete_credential(old_n8n_id)
        except N8nSyncError as exc:
            cred.n8n_sync_error = str(exc)
            log.error("n8n sync failed for user %s provider %s: %s", user.id, provider.name, exc)
    else:
        cred.n8n_sync_error = "n8n is not configured on this server (N8N_API_URL / N8N_API_KEY)."
    db.commit()
    db.refresh(cred)
    audit(db, request, user.id, "oauth_connect", provider=provider.name, n8n_synced=bool(cred.n8n_credential_id))
    return cred


@app.get("/oauth/credentials", response_model=list[CredentialOut])
def list_credentials(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.query(OAuthCredential).filter(OAuthCredential.user_id == user.id).order_by(OAuthCredential.provider).all()


@app.delete("/oauth/credentials/{credential_id}", status_code=204)
async def disconnect(credential_id: int, request: Request, user: User = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    cred = db.query(OAuthCredential).filter(OAuthCredential.id == credential_id,
                                            OAuthCredential.user_id == user.id).first()
    if cred is None:
        raise HTTPException(404, "Credential not found")
    n8n_error = None
    if cred.n8n_credential_id and settings.n8n_enabled:
        try:
            await N8nClient().delete_credential(cred.n8n_credential_id)
        except N8nSyncError as exc:
            n8n_error = str(exc)
    provider = cred.provider
    db.delete(cred)
    db.commit()
    audit(db, request, user.id, "oauth_disconnect", provider=provider, n8n_error=n8n_error)


@app.get("/health")
def health():
    return {"status": "ok", "n8n_configured": settings.n8n_enabled}
