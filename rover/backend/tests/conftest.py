import os
import sys
from pathlib import Path

from cryptography.fernet import Fernet

os.environ.update({
    "SECRET_KEY": "test-secret-key-that-is-long-enough-for-hs256-0123456789",
    "TOKEN_ENCRYPTION_KEY": Fernet.generate_key().decode(),
    "DATABASE_URL": "sqlite://",
    "FRONTEND_URL": "http://localhost:3000",
    "N8N_API_URL": "http://n8n.test",
    "N8N_API_KEY": "n8n-test-key",
    "HUBSPOT_CLIENT_ID": "hs-id", "HUBSPOT_CLIENT_SECRET": "hs-secret",
    "SLACK_CLIENT_ID": "sl-id", "SLACK_CLIENT_SECRET": "sl-secret",
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
from database import Base, engine  # noqa: E402


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(main.app) as c:
        yield c


def signup_and_login(client, email="ops@example.com", password="correct-horse-battery"):
    assert client.post("/users", json={"email": email, "password": password}).status_code == 201
    r = client.post("/token", data={"username": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}
