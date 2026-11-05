use crate::documents::common::*;
use regex::Regex;
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
#[derive(Debug)]
pub struct Unavailable {
    pub message: String,
    pub code: String,
}
impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Unavailable {}
type ApiResult<T> = std::result::Result<T, Unavailable>;
fn unavailable(message: impl Into<String>, code: &str) -> Unavailable {
    Unavailable {
        message: message.into(),
        code: code.into(),
    }
}
pub fn percent(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite())
        .and_then(|n| format!("{:.1}", n.clamp(0., 100.)).parse().ok())
}
pub fn epoch(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_f64().filter(|n| *n > 0.) {
        return Some(n as i64);
    }
    let text = value.as_str()?;
    if let Ok(time) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(time.timestamp());
    }
    if let Ok(time) = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f") {
        use chrono::TimeZone;
        return chrono::Local
            .from_local_datetime(&time)
            .single()
            .map(|d| d.timestamp());
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        use chrono::TimeZone;
        return chrono::Local
            .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
            .single()
            .map(|d| d.timestamp());
    }
    None
}
pub fn short_name(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(24).collect())
}
fn title(text: &str) -> String {
    text.split(' ')
        .map(|s| {
            let mut c = s.chars();
            match c.next() {
                Some(first) => first
                    .to_uppercase()
                    .chain(c.flat_map(char::to_lowercase))
                    .collect(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn scoped(windows: &mut Vec<Value>, name: Option<&str>, more: Vec<Value>) {
    for mut item in more {
        let label = if let Some(name) = name.filter(|n| !n.is_empty()) {
            format!("{name} {}", s(&item["label"]))
        } else {
            s(&item["label"]).to_owned()
        };
        if !windows.iter().any(|w| w["label"] == label) {
            item["label"] = json!(label);
            windows.push(item)
        }
    }
}
pub fn codex_rate(rate: &Value) -> Vec<Value> {
    let mut windows = vec![];
    for (key, fallback) in [("primary_window", "5h"), ("secondary_window", "7d")] {
        let item = &rate[key];
        if let Some(used) = percent(&item["used_percent"]) {
            windows.push(json!({"label":match item["limit_window_seconds"].as_f64(){Some(n) if n==18000.=>"5h",Some(n) if n==604800.=>"7d",_=>fallback},"used":used,"reset":epoch(&item["reset_at"])}))
        }
    }
    windows.sort_by_key(|w| w["label"] != "5h");
    windows
}
pub fn codex_windows(data: &Value) -> Vec<Value> {
    let mut windows = codex_rate(&data["rate_limit"]);
    for item in arr(&data["additional_rate_limits"]) {
        if let Some(name) =
            short_name(&item["limit_name"]).or_else(|| short_name(&item["metered_feature"]))
        {
            scoped(&mut windows, Some(&name), codex_rate(&item["rate_limit"]))
        }
    }
    scoped(
        &mut windows,
        Some("code_review"),
        codex_rate(&data["code_review_rate_limit"]),
    );
    windows
}
pub fn claude_scope(scope: &Value) -> Option<String> {
    for part in ["model", "surface"] {
        let value = &scope[part];
        let name = if value.is_object() {
            short_name(&value["display_name"]).or_else(|| short_name(&value["id"]))
        } else {
            short_name(value)
        };
        if name.is_some() {
            return name;
        }
    }
    None
}
pub fn claude_windows(data: &Value) -> Vec<Value> {
    let mut windows = vec![];
    for (key, label) in [("five_hour", "5h"), ("seven_day", "7d")] {
        let item = &data[key];
        if let Some(used) = percent(&item["utilization"]) {
            windows.push(json!({"label":label,"used":used,"reset":epoch(&item["resets_at"])}))
        }
    }
    if let Some(map) = data.as_object() {
        for (key, item) in map {
            if let Some(model) = key.strip_prefix("seven_day_") {
                if let Some(used) = percent(&item["utilization"]) {
                    scoped(
                        &mut windows,
                        Some(&title(&model.replace('_', " "))),
                        vec![json!({"label":"7d","used":used,"reset":epoch(&item["resets_at"])})],
                    )
                }
            }
        }
    }
    for item in arr(&data["limits"]) {
        let Some(used) = percent(&item["percent"]) else {
            continue;
        };
        let kind = s(&item["kind"]).split('_').next().unwrap_or("");
        let window = match kind {
            "weekly" => Some("7d"),
            "session" | "five" => Some("5h"),
            "daily" => Some("1d"),
            "monthly" => Some("30d"),
            _ => None,
        };
        let name = claude_scope(&item["scope"]);
        if window.is_none() && name.is_none() {
            continue;
        }
        let label = window
            .map(str::to_owned)
            .or_else(|| name.clone())
            .unwrap_or_default();
        scoped(
            &mut windows,
            if window.is_some() {
                name.as_deref()
            } else {
                None
            },
            vec![json!({"label":label,"used":used,"reset":epoch(&item["resets_at"])})],
        )
    }
    windows
}
pub fn codex_credits(data: &Value) -> Value {
    let credits = &data["credits"];
    if !credits.is_object() {
        return Value::Null;
    }
    let value = &credits["balance"];
    let text = if value.is_string() {
        s(value).to_owned()
    } else {
        value.to_string()
    };
    let balance =
        if !value.is_boolean() && (value.is_string() || value.is_number()) && text.len() <= 64 {
            normalize_decimal(&text)
        } else {
            None
        };
    json!({"balance":balance,"has_credits":credits["has_credits"].as_bool(),"unlimited":credits["unlimited"]==true})
}
fn normalize_decimal(text: &str) -> Option<String> {
    use rust_decimal::{Decimal, RoundingStrategy};
    use std::str::FromStr;
    let value = Decimal::from_str(text)
        .or_else(|_| Decimal::from_scientific(text))
        .ok()?;
    if value < Decimal::ZERO || value > Decimal::from(1_000_000_000_000_000_000u64) {
        return None;
    }
    let rounded = value.round_dp_with_strategy(2, RoundingStrategy::MidpointNearestEven);
    let text = format!("{rounded:.2}");
    Some(text.trim_end_matches('0').trim_end_matches('.').to_owned())
}
pub fn response_shape(value: &Value, depth: usize) -> Value {
    match value {
        Value::Object(map) => {
            if depth >= 4 {
                return json!("object");
            }
            let mut out = json!({});
            for (key, child) in map.iter().take(60) {
                out[key.chars().take(60).collect::<String>()] = response_shape(child, depth + 1)
            }
            out
        }
        Value::Array(a) => {
            if a.is_empty() {
                json!([])
            } else {
                json!([response_shape(&a[0], depth + 1)])
            }
        }
        Value::Null => json!("null"),
        Value::Bool(_) => json!("bool"),
        Value::Number(n) => json!(if n.is_f64() { "float" } else { "int" }),
        Value::String(_) => json!("str"),
    }
}
fn save_shape(path: Option<&Path>, data: &Value) {
    if let Some(path) = path {
        let _ = atomic_json(
            path,
            &json!({"updated":now()as i64,"shape":response_shape(data,0)}),
        );
    }
}
pub fn codex_workspace(data: &Value) -> Value {
    let kind = data["rate_limit_reached_type"]
        .as_str()
        .filter(|s| Regex::new("^[a-z_]{1,40}$").unwrap().is_match(s));
    json!({"spend_reached":data["spend_control"]["reached"].as_bool(),"overage_reached":data["credits"]["overage_limit_reached"].as_bool(),"reached_type":kind})
}
fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".codex"))
}
pub fn session_reports(root: &Path, at: f64, hours: f64) -> Option<Value> {
    let mut logs = std::fs::read_dir(root)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| filename(p).starts_with("logs_") && suffix(p) == ".sqlite")
        .collect::<Vec<_>>();
    logs.sort_by_key(|p| {
        stem(p)
            .chars()
            .filter(char::is_ascii_digit)
            .collect::<String>()
            .parse::<u64>()
            .unwrap_or(0)
    });
    let path = logs.last()?;
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    db.busy_timeout(Duration::from_secs(1)).ok()?;
    let since = (at - hours * 3600.) as i64;
    let mut reports = json!({});
    for (kind, phrase) in [
        ("out_of_credits", "out of credits"),
        ("usage_limit", "usage limit reached"),
        ("usage_limit", "limit increase"),
    ] {
        for (scope, where_) in [
            (
                "turn",
                "target = 'codex_core::session::turn' AND feedback_log_body LIKE '%Turn error%'",
            ),
            (
                "connect",
                "target LIKE 'codex_core::%' AND target != 'codex_core::session::turn'",
            ),
        ] {
            let query = format!(
                "SELECT MAX(ts) FROM logs WHERE ts >= ? AND {where_} AND feedback_log_body LIKE ?"
            );
            let stamp = db
                .query_row(
                    &query,
                    rusqlite::params![since, format!("%{phrase}%")],
                    |r| r.get::<_, Option<i64>>(0),
                )
                .ok()?;
            if let Some(stamp) = stamp.filter(|t| *t != 0) {
                if !reports[kind].is_object() {
                    reports[kind] = json!({})
                }
                let old = reports[kind][scope].as_i64().unwrap_or(0);
                reports[kind][scope] = json!(stamp.max(old))
            }
        }
    }
    if reports.as_object().unwrap().is_empty() {
        return Some(reports);
    }
    let stream = db
        .query_row(
            "SELECT MAX(ts) FROM logs WHERE ts >= ? AND target = 'codex_core::stream_events_utils'",
            [since],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()?;
    for entry in reports.as_object_mut().unwrap().values_mut() {
        entry["stream"] = json!(stream.filter(|t| *t != 0))
    }
    Some(reports)
}
fn http(
    url: &str,
    headers: &[(String, String)],
    body: Option<&Value>,
    resets: bool,
) -> ApiResult<Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(if resets { 15 } else { 12 }))
        .build()
        .map_err(|_| {
            unavailable(
                if resets {
                    "Codex 서버에 연결할 수 없습니다."
                } else {
                    "서버에 연결할 수 없습니다."
                },
                "offline",
            )
        })?;
    let mut request = if body.is_some() {
        client.post(url)
    } else {
        client.get(url)
    };
    for (key, value) in headers {
        request = request.header(key, value)
    }
    if let Some(body) = body {
        request = request
            .header("Content-Type", "application/json")
            .body(body.to_string())
    }
    let mut response = request.send().map_err(|_| {
        unavailable(
            if resets {
                "Codex 서버에 연결할 수 없습니다."
            } else {
                "서버에 연결할 수 없습니다."
            },
            "offline",
        )
    })?;
    let status = response.status().as_u16();
    if status >= 400 {
        return Err(match status {
            401 => unavailable(
                if resets {
                    "Codex 로그인이 만료됐습니다. codex 를 열어 다시 로그인하세요."
                } else {
                    "로그인이 만료됐습니다. CLI를 열어 다시 로그인하세요."
                },
                "expired",
            ),
            429 => unavailable(
                if resets {
                    "요청이 많습니다. 잠시 뒤 다시 시도하세요."
                } else {
                    "요청이 많습니다. 잠시 뒤 갱신됩니다."
                },
                "rate_limited",
            ),
            _ => unavailable(
                if resets {
                    format!("Codex 서버가 HTTP {status} 로 응답했습니다.")
                } else {
                    format!("HTTP {status} 응답")
                },
                "http_error",
            ),
        });
    }
    let mut bytes = vec![];
    response
        .by_ref()
        .take(1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            unavailable(
                if resets {
                    "Codex 서버에 연결할 수 없습니다."
                } else {
                    "서버에 연결할 수 없습니다."
                },
                "offline",
            )
        })?;
    if resets && bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(json!({}));
    }
    let data: Value = serde_json::from_slice(&bytes)
        .map_err(|_| unavailable("예상하지 못한 응답입니다.", "bad_response"))?;
    if !data.is_object() {
        return Err(unavailable("예상하지 못한 응답입니다.", "bad_response"));
    }
    Ok(data)
}
fn codex_headers(resets: bool) -> ApiResult<Vec<(String, String)>> {
    let file = codex_home().join("auth.json");
    let auth = read_json(&file).map_err(|_| {
        unavailable(
            if !file.exists() {
                if resets {
                    "Codex 로그인 정보가 없습니다. codex login 후 다시 시도하세요."
                } else {
                    "codex login 이 필요합니다."
                }
            } else {
                "Codex 로그인 정보를 읽을 수 없습니다."
            },
            "not_signed_in",
        )
    })?;
    let tokens = &auth["tokens"];
    let token = tokens["access_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            unavailable(
                if resets {
                    "Codex 구독 로그인이 필요합니다 (API 키 계정은 초기화권이 없습니다)."
                } else {
                    "Codex 구독 로그인이 필요합니다."
                },
                "not_signed_in",
            )
        })?;
    let mut headers = vec![
        ("Authorization".into(), format!("Bearer {token}")),
        (
            "User-Agent".into(),
            if resets {
                "HerdrCodexResets/1.0"
            } else {
                "HerdrPlanUsage/1.0"
            }
            .into(),
        ),
    ];
    if let Some(account) = tokens["account_id"].as_str().filter(|a| !a.is_empty()) {
        headers.push(("ChatGPT-Account-Id".into(), account.into()))
    }
    Ok(headers)
}
fn read_codex(shape: Option<&Path>) -> ApiResult<Value> {
    let data = http(
        "https://chatgpt.com/backend-api/wham/usage",
        &codex_headers(false)?,
        None,
        false,
    )?;
    save_shape(shape, &data);
    Ok(
        json!({"windows":codex_windows(&data),"credits":codex_credits(&data),"workspace":codex_workspace(&data),"limited":data["rate_limit"]["limit_reached"]==true||data["rate_limit"]["allowed"]==false}),
    )
}
#[cfg(target_os = "macos")]
fn macos_keychain(service: &str) -> Option<String> {
    use std::ffi::{c_void, CString};
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainSetUserInteractionAllowed(allowed: bool) -> i32;
        fn SecKeychainFindGenericPassword(
            keychain: *const c_void,
            service_length: u32,
            service: *const i8,
            account_length: u32,
            account: *const i8,
            password_length: *mut u32,
            password: *mut *mut c_void,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainItemFreeContent(attributes: *mut c_void, data: *mut c_void) -> i32;
    }
    unsafe {
        SecKeychainSetUserInteractionAllowed(false);
        let service = CString::new(service).ok()?;
        let mut length = 0;
        let mut data = std::ptr::null_mut();
        if SecKeychainFindGenericPassword(
            std::ptr::null(),
            service.as_bytes().len() as u32,
            service.as_ptr(),
            0,
            std::ptr::null(),
            &mut length,
            &mut data,
            std::ptr::null_mut(),
        ) != 0
        {
            return None;
        }
        let bytes = std::slice::from_raw_parts(data as *const u8, length as usize);
        let result = std::str::from_utf8(bytes).ok().map(str::to_owned);
        SecKeychainItemFreeContent(std::ptr::null_mut(), data);
        result
    }
}
fn read_claude() -> ApiResult<Value> {
    let root = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".claude"));
    let path = root.join(".credentials.json");
    let mut credentials = if path.exists() {
        read_json(&path)
            .map_err(|_| unavailable("Claude 로그인 정보를 읽을 수 없습니다.", "not_signed_in"))?
    } else {
        json!({})
    };
    #[cfg(target_os = "macos")]
    if credentials["claudeAiOauth"].is_null() && std::env::var_os("CLAUDE_CONFIG_DIR").is_none() {
        let raw=macos_keychain("Claude Code-credentials").or_else(||timeout_output(command("/usr/bin/security").args(["find-generic-password","-s","Claude Code-credentials","-w"]),10).ok().filter(|o|o.status.success()).map(|o|String::from_utf8_lossy(&o.stdout).trim().to_owned()).filter(|s|!s.is_empty())).ok_or_else(||unavailable("macOS 키체인에서 Claude 로그인을 읽지 못했습니다. 키체인 잠금을 풀고 갱신하세요.","keychain"))?;
        credentials = serde_json::from_str(&raw)
            .map_err(|_| unavailable("Claude 로그인 정보를 읽을 수 없습니다.", "not_signed_in"))?;
    }
    let oauth = &credentials["claudeAiOauth"];
    let token = oauth["accessToken"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| unavailable("Claude Code 구독 로그인이 필요합니다.", "not_signed_in"))?;
    if oauth["expiresAt"]
        .as_f64()
        .is_some_and(|n| n / 1000. <= now())
    {
        return Err(unavailable(
            "Claude 로그인이 만료됐습니다. Claude Code를 열면 갱신됩니다.",
            "expired",
        ));
    }
    let headers = vec![
        ("Authorization".into(), format!("Bearer {token}")),
        ("anthropic-beta".into(), "oauth-2025-04-20".into()),
        ("User-Agent".into(), "HerdrPlanUsage/1.0".into()),
    ];
    let data = http(
        "https://api.anthropic.com/api/oauth/usage",
        &headers,
        None,
        false,
    )?;
    Ok(json!({"windows":claude_windows(&data),"limited":null}))
}
pub fn read_provider(provider: &str, shape: Option<&Path>) -> Value {
    let mut result = match if provider == "codex" {
        read_codex(shape)
    } else {
        read_claude()
    } {
        Ok(mut result) => {
            result["error"] = Value::Null;
            result
        }
        Err(error) => json!({"windows":[],"limited":null,"error":error.message,"code":error.code}),
    };
    if provider == "codex" {
        result["reports"] = json!(session_reports(&codex_home(), now(), 24.))
    }
    result["updated"] = json!(now() as i64);
    result
}
pub fn usable(details: &Value) -> Vec<Value> {
    let mut found = arr(&details["credits"])
        .into_iter()
        .filter_map(|item| {
            if item["status"] != "available"
                || item["is_supported_by_plan"] == false
                || (!item["reset_type"].is_null() && item["reset_type"] != "codex_rate_limits")
            {
                return None;
            }
            let id = item["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.chars().count() <= 128)?;
            let expires = item["expires_at"]
                .as_str()
                .filter(|e| e.chars().count() <= 64);
            Some(json!({"id":id,"expires":expires}))
        })
        .collect::<Vec<_>>();
    found.sort_by_key(|i| (i["expires"].is_null(), s(&i["expires"]).to_owned()));
    found
}
pub fn reset_summary(usage: &Value, details: &Value) -> Value {
    let mut windows = vec![];
    let rate = &usage["rate_limit"];
    for key in ["primary_window", "secondary_window"] {
        let item = &rate[key];
        if let Some(used) = item["used_percent"].as_f64() {
            // Python max(0, min(100, float(used))) returns the integer
            // boundary operand on ties, and a float strictly inside it.
            let used = if used <= 0. {
                json!(0)
            } else if used >= 100. {
                json!(100)
            } else {
                json!(used)
            };
            windows.push(json!({"label":match item["limit_window_seconds"].as_f64(){Some(n) if n==604800.=>Some("7일"),Some(n) if n==18000.=>Some("5시간"),_=>None},"used":used,"reset":if item["reset_at"].is_number()||item["reset_at"].is_boolean(){item["reset_at"].clone()}else{Value::Null}}))
        }
    }
    let credits = usable(details);
    json!({"available":credits.len(),"expiries":credits.iter().take(10).map(|c|c["expires"].clone()).collect::<Vec<_>>(),"limited":rate["limit_reached"]==true||rate["allowed"]==false,"windows":windows,"error":null})
}
fn reset_request(
    path: &str,
    headers: &[(String, String)],
    body: Option<&Value>,
) -> ApiResult<Value> {
    http(
        &format!("https://chatgpt.com/backend-api/wham{path}"),
        headers,
        body,
        true,
    )
}
pub fn reset_run(use_one: bool) -> Value {
    let mut used = false;
    let mut use_error = None;
    if use_one {
        let result = (|| -> ApiResult<()> {
            let headers = codex_headers(true)?;
            let credits = usable(&reset_request("/rate-limit-reset-credits", &headers, None)?);
            let first = credits
                .first()
                .ok_or_else(|| unavailable("사용할 수 있는 초기화권이 없습니다.", "no_reset"))?;
            reset_request(
                "/rate-limit-reset-credits/consume",
                &headers,
                Some(
                    &json!({"credit_id":first["id"],"redeem_request_id":uuid::Uuid::new_v4().to_string()}),
                ),
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => used = true,
            Err(error) => use_error = Some(error.message),
        }
    }
    let result = (|| -> ApiResult<Value> {
        let headers = codex_headers(true)?;
        Ok(reset_summary(
            &reset_request("/usage", &headers, None)?,
            &reset_request("/rate-limit-reset-credits", &headers, None)?,
        ))
    })();
    let mut result = match result {
        Ok(result) => result,
        Err(error) => {
            json!({"available":null,"expiries":[],"limited":null,"windows":[],"error":error.message,"code":error.code})
        }
    };
    if use_one {
        result["used"] = json!(used);
        result["use_error"] = json!(use_error)
    }
    result
}
pub fn usage_cli(args: &[String]) -> Result<()> {
    let mut providers = positionals(args, &[]);
    if providers.is_empty() {
        providers = vec!["codex".into(), "claude".into()]
    }
    if providers.iter().any(|n| n != "codex" && n != "claude") {
        return Err("providers must be codex or claude".into());
    }
    let shape = option(args, "--shape-file").map(PathBuf::from);
    let mut output = json!({});
    for provider in providers {
        output[&provider] = read_provider(&provider, shape.as_deref())
    }
    println!("{output}");
    Ok(())
}
pub fn resets_cli(args: &[String]) -> Result<()> {
    println!("{}", reset_run(has(args, "--use")));
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reset_summary_preserves_python_boundary_number_types() {
        for (input, expected) in [
            (json!(-1), json!(0)),
            (json!(0.0), json!(0)),
            (json!(50), json!(50.0)),
            (json!(100.0), json!(100)),
            (json!(101), json!(100)),
        ] {
            let result = reset_summary(
                &json!({"rate_limit":{"primary_window":{"used_percent":input,"reset_at":123}}}),
                &json!({}),
            );
            assert_eq!(result["windows"][0]["used"], expected);
            assert_eq!(result["windows"][0]["reset"], json!(123));
        }
        assert_eq!(
            codex_rate(&json!({"primary_window":{"used_percent":100}}))[0]["used"],
            json!(100.0)
        );
    }
    #[test]
    fn models_keep_their_own_windows_without_duplicates() {
        assert_eq!(
            codex_windows(
                &json!({"rate_limit":{"primary_window":{"used_percent":12,"limit_window_seconds":18000}},"additional_rate_limits":[{"limit_name":"spark","rate_limit":{"secondary_window":{"used_percent":45}}}]})
            ),
            vec![
                json!({"label":"5h","used":12.,"reset":null}),
                json!({"label":"spark 7d","used":45.,"reset":null})
            ]
        );
    }
    #[test]
    fn reset_order_skips_unsupported_and_spent() {
        let credits = usable(
            &json!({"credits":[{"id":"late","status":"available"},{"id":"early","status":"available","expires_at":"2026-01-01"},{"id":"unsupported","status":"available","is_supported_by_plan":false},{"id":"used","status":"consumed"}]}),
        );
        assert_eq!(
            credits.iter().map(|x| s(&x["id"])).collect::<Vec<_>>(),
            vec!["early", "late"]
        );
    }
    #[test]
    fn shape_never_serializes_values() {
        let shape = response_shape(&json!({"secret":"token-value","usage":[{"x":15}]}), 0);
        assert!(!shape.to_string().contains("token-value"));
        assert_eq!(shape, json!({"secret":"str","usage":[{"x":"int"}]}));
    }
}
