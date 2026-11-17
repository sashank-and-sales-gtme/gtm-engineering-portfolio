from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import relationship

from crypto import EncryptedText
from database import Base, utcnow


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    last_login = Column(DateTime)
    failed_login_attempts = Column(Integer, default=0, nullable=False)
    account_locked_until = Column(DateTime)
    mfa_enabled = Column(Boolean, default=False, nullable=False)
    mfa_secret = Column(EncryptedText)

    credentials = relationship("OAuthCredential", back_populates="user", cascade="all, delete-orphan")


class OAuthState(Base):
    """One-time state value for an in-flight OAuth authorization, bound to the user who started it."""

    __tablename__ = "oauth_states"

    id = Column(Integer, primary_key=True)
    state = Column(String, unique=True, index=True, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    provider = Column(String, nullable=False)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used = Column(Boolean, default=False, nullable=False)


class OAuthCredential(Base):
    __tablename__ = "oauth_credentials"
    __table_args__ = (UniqueConstraint("user_id", "provider", name="uq_user_provider"),)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    provider = Column(String, index=True, nullable=False)
    access_token = Column(EncryptedText, nullable=False)
    refresh_token = Column(EncryptedText)
    token_payload = Column(EncryptedText)  # full provider token response (JSON), needed for the n8n handoff
    expires_at = Column(DateTime)
    scope = Column(String)
    provider_account = Column(String)  # portal, org, team or mailbox the user connected
    provider_metadata = Column(JSON, default=dict)
    n8n_credential_id = Column(String)
    n8n_credential_type = Column(String)
    n8n_sync_error = Column(String)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    user = relationship("User", back_populates="credentials")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"))
    action = Column(String, nullable=False)
    ip_address = Column(String)
    user_agent = Column(String)
    details = Column(JSON, default=dict)
    created_at = Column(DateTime, default=utcnow, nullable=False)
