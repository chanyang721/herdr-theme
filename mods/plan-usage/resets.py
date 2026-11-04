#!/usr/bin/env python3
"""Codex limit resets: read how many are left, or use one on an explicit click.

Reads the Codex CLI sign-in (CODEX_HOME/auth.json) and talks only to the
ChatGPT endpoints the Codex CLI itself uses. Never prints tokens, credit ids
or raw provider text.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import sys
import urllib.error
import urllib.request
import uuid

API = "https://chatgpt.com/backend-api/wham"


class Unavailable(Exception):
    def __init__(self, message, code="unavailable"):
        super().__init__(message)
        self.code = code


def headers():
    root = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    try:
        tokens = json.loads((root / "auth.json").read_text(encoding="utf-8")).get("tokens") or {}
    except FileNotFoundError:
        raise Unavailable("Codex 로그인 정보가 없습니다. codex login 후 다시 시도하세요.", "not_signed_in") from None
    except (OSError, ValueError, AttributeError):
        raise Unavailable("Codex 로그인 정보를 읽을 수 없습니다.", "not_signed_in") from None
    token = tokens.get("access_token")
    if not isinstance(token, str) or not token:
        raise Unavailable("Codex 구독 로그인이 필요합니다 (API 키 계정은 초기화권이 없습니다).", "not_signed_in")
    sent = {"Authorization": "Bearer " + token, "User-Agent": "HerdrCodexResets/1.0"}
    if isinstance(tokens.get("account_id"), str) and tokens["account_id"]:
        sent["ChatGPT-Account-Id"] = tokens["account_id"]
    return sent


def request(path, sent, body=None):
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        sent = {**sent, "Content-Type": "application/json"}
    req = urllib.request.Request(API + path, data=data, headers=sent, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            raw = response.read(1024 * 1024)
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise Unavailable("Codex 로그인이 만료됐습니다. codex 를 열어 다시 로그인하세요.", "expired") from None
        if error.code == 429:
            raise Unavailable("요청이 많습니다. 잠시 뒤 다시 시도하세요.", "rate_limited") from None
        raise Unavailable(f"Codex 서버가 HTTP {error.code} 로 응답했습니다.", "http_error") from None
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError):
        raise Unavailable("Codex 서버에 연결할 수 없습니다.", "offline") from None
    if not raw.strip():
        return {}
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeError):
        raise Unavailable("예상하지 못한 응답입니다.", "bad_response") from None
    if not isinstance(result, dict):
        raise Unavailable("예상하지 못한 응답입니다.", "bad_response")
    return result


def usable(details):
    """Available, plan-supported Codex resets, soonest expiry first (undated last)."""
    found = []
    for item in details.get("credits") if isinstance(details.get("credits"), list) else []:
        if not isinstance(item, dict) or item.get("status") != "available" or item.get("is_supported_by_plan") is False:
            continue
        if item.get("reset_type") not in (None, "codex_rate_limits"):
            continue
        credit_id = item.get("id")
        if not isinstance(credit_id, str) or not credit_id or len(credit_id) > 128:
            continue
        expires = item.get("expires_at")
        expires = expires if isinstance(expires, str) and len(expires) <= 64 else None
        found.append({"id": credit_id, "expires": expires})
    return sorted(found, key=lambda item: (item["expires"] is None, item["expires"] or ""))


def window_label(seconds):
    return "7일" if seconds == 604800 else "5시간" if seconds == 18000 else None


def summary(usage, details):
    rate = usage.get("rate_limit") if isinstance(usage.get("rate_limit"), dict) else {}
    windows = []
    for key in ("primary_window", "secondary_window"):
        item = rate.get(key)
        if not isinstance(item, dict):
            continue
        used = item.get("used_percent")
        if isinstance(used, (int, float)) and not isinstance(used, bool):
            windows.append({"label": window_label(item.get("limit_window_seconds")), "used": max(0, min(100, float(used))),
                            "reset": item.get("reset_at") if isinstance(item.get("reset_at"), (int, float)) else None})
    credits = usable(details)
    return {"available": len(credits), "expiries": [item["expires"] for item in credits][:10],
            "limited": rate.get("limit_reached") is True or rate.get("allowed") is False,
            "windows": windows, "error": None}


def read(sent=None):
    sent = sent or headers()
    return summary(request("/usage", sent), request("/rate-limit-reset-credits", sent))


def use(sent=None):
    sent = sent or headers()
    credits = usable(request("/rate-limit-reset-credits", sent))
    if not credits:
        raise Unavailable("사용할 수 있는 초기화권이 없습니다.", "no_reset")
    # Same idempotency field the Codex CLI sends, so a retried request cannot spend twice.
    request("/rate-limit-reset-credits/consume", sent,
            {"credit_id": credits[0]["id"], "redeem_request_id": str(uuid.uuid4())})


def run(use_one=False):
    used, use_error = False, None
    if use_one:
        try:
            use()
            used = True
        except Unavailable as error:
            use_error = str(error)
        except Exception:
            use_error = "초기화권 요청을 끝내지 못했습니다."
    try:
        result = read()
    except Unavailable as error:
        result = {"available": None, "expiries": [], "limited": None, "windows": [], "error": str(error), "code": error.code}
    except Exception:
        result = {"available": None, "expiries": [], "limited": None, "windows": [], "error": "초기화권 정보를 읽지 못했습니다.", "code": "reader_error"}
    if use_one:
        result["used"], result["use_error"] = used, use_error
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--use", action="store_true", help="Use one reset (the one expiring first). Explicit click only.")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(run(args.use), ensure_ascii=False, allow_nan=False))
