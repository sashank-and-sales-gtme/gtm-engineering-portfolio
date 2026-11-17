"""Encrypts OAuth tokens at rest with Fernet (AES-128-CBC + HMAC-SHA256)."""
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import Text
from sqlalchemy.types import TypeDecorator

from config import settings

_fernet: Fernet | None = None


def fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(settings.token_encryption_key.encode())
    return _fernet


class EncryptedText(TypeDecorator):
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return fernet().encrypt(str(value).encode()).decode()

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        try:
            return fernet().decrypt(value.encode()).decode()
        except InvalidToken as exc:
            raise RuntimeError("Stored token could not be decrypted. Was TOKEN_ENCRYPTION_KEY rotated?") from exc
