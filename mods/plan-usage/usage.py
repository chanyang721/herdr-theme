#!/usr/bin/env python3
"""Codex and Claude subscription limits (5-hour / weekly windows) as percentages.

Reads the CLIs' own sign-ins and asks each provider's usage endpoint with its
own token only. Never prints tokens or raw provider text.
"""
import argparse
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import socket
import sys
import time
import urllib.error
import urllib.request


class Unavailable(Exception):
    def __init__(self, message, code='unavailable'):
        super().__init__(message)
        self.code = code


def get(url, headers):
    req = urllib.request.Request(url, headers={'User-Agent': 'HerdrPlanUsage/1.0', **headers})
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            data = json.loads(response.read(1024 * 1024))
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise Unavailable('로그인이 만료됐습니다. CLI를 열어 다시 로그인하세요.', 'expired') from None
        if error.code == 429:
            raise Unavailable('요청이 많습니다. 잠시 뒤 갱신됩니다.', 'rate_limited') from None
        raise Unavailable(f'HTTP {error.code} 응답', 'http_error') from None
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError):
        raise Unavailable('서버에 연결할 수 없습니다.', 'offline') from None
    except (ValueError, UnicodeError):
        raise Unavailable('예상하지 못한 응답입니다.', 'bad_response') from None
    if not isinstance(data, dict):
        raise Unavailable('예상하지 못한 응답입니다.', 'bad_response')
    return data


def percent(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return None
    return round(max(0.0, min(100.0, float(value))), 1)


def label_for(seconds, fallback):
    return {18000: '5h', 604800: '7d'}.get(seconds, fallback)


def epoch(value):
    """Reset time as unix seconds from a number or an ISO string; None when unknown."""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return int(value)
    if isinstance(value, str) and value:
        from datetime import datetime
        try:
            return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())
        except ValueError:
            return None
    return None


def codex_windows(data):
    rate = data.get('rate_limit') if isinstance(data.get('rate_limit'), dict) else {}
    windows = []
    for key, fallback in (('primary_window', '5h'), ('secondary_window', '7d')):
        item = rate.get(key)
        if isinstance(item, dict) and percent(item.get('used_percent')) is not None:
            windows.append({'label': label_for(item.get('limit_window_seconds'), fallback),
                            'used': percent(item['used_percent']), 'reset': epoch(item.get('reset_at'))})
    # Short window first, then weekly.
    return sorted(windows, key=lambda w: w['label'] != '5h')


def claude_windows(data):
    windows = []
    for key, label in (('five_hour', '5h'), ('seven_day', '7d')):
        item = data.get(key)
        if isinstance(item, dict) and percent(item.get('utilization')) is not None:
            windows.append({'label': label, 'used': percent(item['utilization']), 'reset': epoch(item.get('resets_at'))})
    return windows


def codex_credits(data):
    """Additional usage balance, separate from subscription windows and reset vouchers."""
    credits = data.get('credits')
    if not isinstance(credits, dict):
        return None
    balance = credits.get('balance')
    normalized = None
    if isinstance(balance, (str, int, float)) and not isinstance(balance, bool) and len(str(balance)) <= 64:
        try:
            value = Decimal(str(balance))
            if value.is_finite() and 0 <= value <= Decimal('1e18'):
                normalized = format(value, '.2f').rstrip('0').rstrip('.')
        except InvalidOperation:
            pass
    has_credits = credits.get('has_credits')
    return {'balance': normalized, 'has_credits': has_credits if isinstance(has_credits, bool) else None,
            'unlimited': credits.get('unlimited') is True}


def codex():
    root = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex'))
    try:
        tokens = json.loads((root / 'auth.json').read_text(encoding='utf-8')).get('tokens') or {}
    except FileNotFoundError:
        raise Unavailable('codex login 이 필요합니다.', 'not_signed_in') from None
    except (OSError, ValueError, AttributeError):
        raise Unavailable('Codex 로그인 정보를 읽을 수 없습니다.', 'not_signed_in') from None
    token = tokens.get('access_token')
    if not isinstance(token, str) or not token:
        raise Unavailable('Codex 구독 로그인이 필요합니다.', 'not_signed_in')
    headers = {'Authorization': 'Bearer ' + token}
    if isinstance(tokens.get('account_id'), str) and tokens['account_id']:
        headers['ChatGPT-Account-Id'] = tokens['account_id']
    data = get('https://chatgpt.com/backend-api/wham/usage', headers)
    rate = data.get('rate_limit') if isinstance(data.get('rate_limit'), dict) else {}
    return {'windows': codex_windows(data), 'credits': codex_credits(data),
            'limited': rate.get('limit_reached') is True or rate.get('allowed') is False}


def macos_keychain(service):
    """One exact generic-password item, never prompting; None when it is not readable silently."""
    import ctypes
    security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    security.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_bool]
    security.SecKeychainSetUserInteractionAllowed(False)
    security.SecKeychainFindGenericPassword.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p,
        ctypes.c_uint32, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    security.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    name = service.encode()
    length, data = ctypes.c_uint32(), ctypes.c_void_p()
    if security.SecKeychainFindGenericPassword(None, len(name), name, 0, None, ctypes.byref(length), ctypes.byref(data), None):
        return None
    try:
        return ctypes.string_at(data, length.value).decode('utf-8')
    finally:
        security.SecKeychainItemFreeContent(None, data)


def security_password(service):
    """The same item through /usr/bin/security, never prompting; None when unreadable."""
    import subprocess
    try:
        result = subprocess.run(['/usr/bin/security', 'find-generic-password', '-s', service, '-w'],
                                capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() or None if result.returncode == 0 else None


def claude():
    root = Path(os.environ.get('CLAUDE_CONFIG_DIR', Path.home() / '.claude'))
    try:
        credentials = json.loads((root / '.credentials.json').read_text(encoding='utf-8'))
    except FileNotFoundError:
        credentials = {}
    except (OSError, ValueError):
        raise Unavailable('Claude 로그인 정보를 읽을 수 없습니다.', 'not_signed_in') from None
    if not credentials.get('claudeAiOauth') and sys.platform == 'darwin' and 'CLAUDE_CONFIG_DIR' not in os.environ:
        # Claude Code saves this item through /usr/bin/security, so that tool stays
        # on the item's access list when this Python is refused.
        raw = macos_keychain('Claude Code-credentials') or security_password('Claude Code-credentials')
        if raw is None:
            raise Unavailable('macOS 키체인에서 Claude 로그인을 읽지 못했습니다. 키체인 잠금을 풀고 갱신하세요.', 'keychain')
        try:
            credentials = json.loads(raw)
        except ValueError:
            raise Unavailable('Claude 로그인 정보를 읽을 수 없습니다.', 'not_signed_in') from None
    oauth = credentials.get('claudeAiOauth') if isinstance(credentials, dict) else None
    token = oauth.get('accessToken') if isinstance(oauth, dict) else None
    if not isinstance(token, str) or not token:
        raise Unavailable('Claude Code 구독 로그인이 필요합니다.', 'not_signed_in')
    expires = oauth.get('expiresAt')
    if isinstance(expires, (int, float)) and expires / 1000 <= time.time():
        raise Unavailable('Claude 로그인이 만료됐습니다. Claude Code를 열면 갱신됩니다.', 'expired')
    data = get('https://api.anthropic.com/api/oauth/usage',
               {'Authorization': 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20'})
    return {'windows': claude_windows(data), 'limited': None}


def read(provider):
    try:
        result = {'codex': codex, 'claude': claude}[provider]()
        result['error'] = None
    except Unavailable as error:
        result = {'windows': [], 'limited': None, 'error': str(error), 'code': error.code}
    except Exception:
        result = {'windows': [], 'limited': None, 'error': '사용량을 읽지 못했습니다.', 'code': 'reader_error'}
    result['updated'] = int(time.time())
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('providers', nargs='*', help='codex and/or claude (default: both)')
    args = parser.parse_args()
    providers = args.providers or ['codex', 'claude']
    if any(name not in ('codex', 'claude') for name in providers):
        parser.error('providers must be codex or claude')
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps({name: read(name) for name in providers}, ensure_ascii=False, allow_nan=False))
