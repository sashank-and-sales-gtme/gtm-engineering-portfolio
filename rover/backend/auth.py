import base64
from datetime import timedelta
from io import BytesIO

import bcrypt
import jwt
import pyotp
import qrcode
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from config import settings
from database import get_db, utcnow
from models import User

ALGORITHM = "HS256"
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        return False


def create_access_token(email: str) -> tuple[str, int]:
    expires_in = settings.access_token_minutes * 60
    payload = {"sub": email, "exp": utcnow() + timedelta(seconds=expires_in), "iat": utcnow()}
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM), expires_in


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    unauthorized = HTTPException(status.HTTP_401_UNAUTHORIZED, "Could not validate credentials",
                                 headers={"WWW-Authenticate": "Bearer"})
    try:
        email = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM]).get("sub")
    except jwt.PyJWTError:
        raise unauthorized
    user = db.query(User).filter(User.email == email).first() if email else None
    if user is None or not user.is_active:
        raise unauthorized
    return user


def is_locked(user: User) -> bool:
    return bool(user.account_locked_until and user.account_locked_until > utcnow())


def register_failed_login(user: User, db: Session) -> None:
    user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
    if user.failed_login_attempts >= settings.max_failed_logins:
        user.account_locked_until = utcnow() + timedelta(minutes=settings.lockout_minutes)
        user.failed_login_attempts = 0
    db.commit()


def verify_totp(secret: str, code: str) -> bool:
    return pyotp.TOTP(secret).verify(code.strip(), valid_window=1)


def new_mfa_setup(email: str) -> tuple[str, str, str]:
    secret = pyotp.random_base32()
    uri = pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name="Rover")
    img = qrcode.make(uri)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return secret, uri, base64.b64encode(buf.getvalue()).decode()
