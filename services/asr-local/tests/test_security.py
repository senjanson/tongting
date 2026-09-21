"""令牌、Origin、Host、Fetch Metadata 与 CORS 相关行为。"""

from __future__ import annotations

import pytest

from conftest import EXTENSION_ID, EXTENSION_ORIGIN, make_wav, running_app

HEALTH_KEYS = {"status", "ready", "model", "device", "computeType", "version", "youtubePreload"}


def assert_error(response, status: int, code: str) -> None:
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message"}
    assert body["error"]["code"] == code
    assert body["error"]["message"]


def assert_no_cors(response) -> None:
    assert not [name for name in response.headers if name.lower().startswith("access-control-")]


# ---- /health ----


def test_health_requires_no_token_and_has_exact_contract_keys(harness):
    response = harness.client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == HEALTH_KEYS
    assert body["status"] == "ok"
    assert body["ready"] is True
    assert body["model"] == "fake-small"
    assert body["device"] == "cpu"
    assert body["computeType"] == "int8"
    assert body["youtubePreload"] is False
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert_no_cors(response)


# ---- 令牌 ----


def test_transcribe_without_token_is_401(harness):
    response = harness.client.post("/v1/transcribe", content=make_wav(), headers={"Content-Type": "audio/wav"})
    assert_error(response, 401, "unauthorized")
    assert response.headers["www-authenticate"].startswith("Bearer")
    assert harness.transcriber.calls == []


@pytest.mark.parametrize(
    "authorization",
    [
        "Bearer wrong-token-value-wrong-token-value-000",
        "Bearer ",
        "Basic dXNlcjpwYXNz",
        "token-without-scheme",
    ],
)
def test_transcribe_with_wrong_token_is_401(harness, authorization):
    response = harness.client.post(
        "/v1/transcribe",
        content=make_wav(),
        headers={"Content-Type": "audio/wav", "Authorization": authorization},
    )
    assert_error(response, 401, "unauthorized")
    assert harness.transcriber.calls == []


def test_error_bodies_never_echo_token_or_audio(harness):
    wav = make_wav()
    response = harness.client.post(
        "/v1/transcribe",
        content=wav,
        headers={"Content-Type": "audio/wav", "Authorization": f"Bearer {harness.token}x"},
    )
    assert harness.token not in response.text
    assert response.status_code == 401

    bad = b"NOT A WAV" + harness.token.encode()
    response = harness.post_wav(bad)
    assert response.status_code == 415
    assert harness.token not in response.text
    assert "NOT A WAV" not in response.text


def test_unknown_paths_require_token_and_docs_are_disabled(harness):
    for path in ("/v1/unknown", "/docs", "/openapi.json", "/redoc", "//v1/transcribe"):
        assert_error(harness.client.get(path), 401, "unauthorized")
        assert_error(harness.client.get(path, headers=harness.auth), 404, "not_found")


def test_wrong_method_is_error_shaped(harness):
    assert_error(harness.client.get("/v1/transcribe", headers=harness.auth), 405, "method_not_allowed")


# ---- Origin ----


@pytest.mark.parametrize(
    "origin",
    [
        "https://www.youtube.com",
        "http://127.0.0.1:8765",
        "null",
        "chrome-extension://evil",
        "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
        f"{EXTENSION_ORIGIN}.evil.com",
        "moz-extension://abcdefghijklmnopabcdefghijklmnop",
    ],
)
def test_non_extension_origin_is_403_even_with_valid_token(harness, origin):
    response = harness.post_wav(make_wav(), headers={"Origin": origin})
    assert_error(response, 403, "origin_not_allowed")
    assert_no_cors(response)
    assert harness.transcriber.calls == []
    # /health 同样拒绝网页来源。
    assert_error(harness.client.get("/health", headers={"Origin": origin}), 403, "origin_not_allowed")


def test_web_origin_preflight_is_rejected_without_cors_headers(harness):
    response = harness.client.options(
        "/v1/transcribe",
        headers={
            "Origin": "https://www.youtube.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert_error(response, 403, "origin_not_allowed")
    assert_no_cors(response)


def test_chrome_extension_origin_is_allowed_with_token(harness):
    response = harness.post_wav(make_wav(), headers={"Origin": EXTENSION_ORIGIN})
    assert response.status_code == 200, response.text
    assert_no_cors(response)
    assert harness.client.get("/health", headers={"Origin": EXTENSION_ORIGIN}).status_code == 200


def test_chrome_extension_origin_still_needs_token(harness):
    response = harness.client.post(
        "/v1/transcribe",
        content=make_wav(),
        headers={"Content-Type": "audio/wav", "Origin": EXTENSION_ORIGIN},
    )
    assert_error(response, 401, "unauthorized")


def test_no_origin_like_local_curl_is_allowed_with_token(harness):
    assert harness.post_wav(make_wav()).status_code == 200


def test_multiple_origin_headers_are_rejected(harness):
    response = harness.client.post(
        "/v1/transcribe",
        content=make_wav(),
        headers=[
            ("Content-Type", "audio/wav"),
            ("Authorization", f"Bearer {harness.token}"),
            ("Origin", EXTENSION_ORIGIN),
            ("Origin", "https://evil.example"),
        ],
    )
    assert_error(response, 403, "origin_not_allowed")


def test_allow_extension_id_restricts_to_exact_extension():
    other = "ponmlkjihgfedcbaponmlkjihgfedcba"
    with running_app(allowed_extension_ids=frozenset({EXTENSION_ID})) as h:
        assert h.post_wav(make_wav(), headers={"Origin": EXTENSION_ORIGIN}).status_code == 200
        assert_error(
            h.post_wav(make_wav(), headers={"Origin": f"chrome-extension://{other}"}),
            403,
            "origin_not_allowed",
        )
        # 无 Origin 的本机调用不受扩展 ID 限制，但仍需令牌。
        assert h.post_wav(make_wav()).status_code == 200


@pytest.mark.parametrize(
    ("mode", "site"),
    [("no-cors", "cross-site"), ("navigate", "cross-site"), ("no-cors", "same-site")],
)
def test_browser_requests_without_origin_from_web_pages_are_rejected(harness, mode, site):
    # 例如网页用 <img>/<script> 或链接探测本机服务：浏览器不带 Origin，但带 Sec-Fetch-*。
    response = harness.client.get("/health", headers={"Sec-Fetch-Mode": mode, "Sec-Fetch-Site": site})
    assert_error(response, 403, "origin_not_allowed")


def test_user_typing_health_url_in_address_bar_is_allowed(harness):
    response = harness.client.get("/health", headers={"Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none"})
    assert response.status_code == 200


# ---- Host（DNS rebinding） ----


@pytest.mark.parametrize(
    "host",
    ["evil.example:8765", "127.0.0.1:9999", "127.0.0.1", "localhost", "0.0.0.0:8765", "[::1]:8765", "192.168.1.2:8765"],
)
def test_bad_host_header_is_403(harness, host):
    assert_error(harness.client.get("/health", headers={"Host": host}), 403, "host_not_allowed")
    response = harness.post_wav(make_wav(), headers={"Host": host})
    assert_error(response, 403, "host_not_allowed")
    assert harness.transcriber.calls == []


@pytest.mark.parametrize("host", ["127.0.0.1:8765", "localhost:8765", "LOCALHOST:8765"])
def test_loopback_host_header_is_allowed(harness, host):
    assert harness.client.get("/health", headers={"Host": host}).status_code == 200
