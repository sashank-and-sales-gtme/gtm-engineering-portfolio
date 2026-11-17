import pyotp

from conftest import signup_and_login


def test_signup_rejects_short_password(client):
    r = client.post("/users", json={"email": "a@example.com", "password": "short"})
    assert r.status_code == 422


def test_duplicate_signup_rejected(client):
    signup_and_login(client)
    assert client.post("/users", json={"email": "OPS@example.com", "password": "another-long-pass"}).status_code == 400


def test_lockout_after_five_failures(client):
    signup_and_login(client)
    for _ in range(5):
        assert client.post("/token", data={"username": "ops@example.com", "password": "wrong-password"}).status_code == 401
    r = client.post("/token", data={"username": "ops@example.com", "password": "correct-horse-battery"})
    assert r.status_code == 423


def test_mfa_required_once_enabled(client):
    headers = signup_and_login(client)
    setup = client.post("/mfa/setup", headers=headers).json()
    assert setup["qr_code_png_base64"]
    code = pyotp.TOTP(setup["secret"]).now()
    assert client.post("/mfa/enable", json={"code": code}, headers=headers).status_code == 204

    no_code = client.post("/token", data={"username": "ops@example.com", "password": "correct-horse-battery"})
    assert no_code.status_code == 401 and no_code.json()["detail"] == "mfa_required"
    wrong = client.post("/token", data={"username": "ops@example.com", "password": "correct-horse-battery", "mfa_code": "000000"})
    assert wrong.status_code == 401
    ok = client.post("/token", data={"username": "ops@example.com", "password": "correct-horse-battery",
                                     "mfa_code": pyotp.TOTP(setup["secret"]).now()})
    assert ok.status_code == 200


def test_protected_routes_need_token(client):
    assert client.get("/users/me").status_code == 401
    assert client.get("/oauth/credentials").status_code == 401
