"""Creates a user from the command line: python scripts/create_user.py you@company.com"""
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from auth import hash_password  # noqa: E402
from database import Base, SessionLocal, engine  # noqa: E402
from models import User  # noqa: E402


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: python scripts/create_user.py EMAIL")
    email = sys.argv[1].strip().lower()
    password = getpass.getpass("Password (min 10 characters): ")
    if len(password) < 10:
        sys.exit("Password too short.")
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        if db.query(User).filter(User.email == email).first():
            sys.exit(f"{email} already exists.")
        db.add(User(email=email, hashed_password=hash_password(password)))
        db.commit()
    print(f"Created {email}")


if __name__ == "__main__":
    main()
