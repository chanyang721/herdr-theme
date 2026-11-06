use super::{common::*, pins::documents};
use regex::Regex;
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path};
pub fn load(path: &Path) -> Option<Value> {
    let data = read_json(path).ok()?;
    if data["version"] != 1 || !data["spaces"].is_object() {
        return None;
    }
    let mut spaces = json!({});
    for (name, value) in data["spaces"].as_object()? {
        let terms = if value.is_object() {
            arr(&value["terms"])
        } else {
            arr(value)
        };
        let mut terms = terms
            .iter()
            .filter_map(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| fold(s).trim().to_owned())
            .collect::<Vec<_>>();
        terms.sort_by_key(|t| std::cmp::Reverse(t.chars().count()));
        terms.dedup();
        if !terms.is_empty() {
            spaces[fold(name)] = json!({"name":name,"terms":terms})
        }
    }
    let sources = arr(&data["sources"])
        .into_iter()
        .filter_map(|v| {
            if v.is_string() {
                Some(json!({"path":v}))
            } else if v["path"].is_string() {
                Some(v)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    Some(json!({"fallback":data["fallback"],"sources":sources,"spaces":spaces}))
}
fn html_text(text: &str) -> String {
    let stripped = Regex::new(r"(?s)<[^>]+>").unwrap().replace_all(text, " ");
    html_escape::decode_html_entities(&stripped).into_owned()
}
fn normalize(text: &str) -> String {
    fold(&text.split_whitespace().collect::<Vec<_>>().join(" "))
}
pub fn head(item: &Value) -> (String, String) {
    let path = Path::new(s(&item["path"]));
    let ext = suffix(path);
    if ![".md", ".txt", ".html", ".htm"].contains(&ext.as_str()) {
        return (String::new(), String::new());
    }
    let Ok(file) = fs::File::open(path) else {
        return (String::new(), String::new());
    };
    let mut bytes = vec![];
    let _ = file
        .take(if ext == ".html" || ext == ".htm" {
            16384
        } else {
            4096
        })
        .read_to_end(&mut bytes);
    let text = String::from_utf8_lossy(&bytes);
    let (title, body) = if ext == ".html" || ext == ".htm" {
        let title = Regex::new(r"(?is)<title[^>]*>(.*?)</title\s*>")
            .unwrap()
            .captures(&text)
            .map(|c| html_text(&c[1]))
            .unwrap_or_default();
        let mut clean = text.to_string();
        for tag in ["script", "style"] {
            clean = Regex::new(&format!(r"(?is)<{tag}\b.*?</{tag}\s*>"))
                .unwrap()
                .replace_all(&clean, " ")
                .into_owned()
        }
        let body = html_text(&clean).chars().take(4096).collect();
        (title, body)
    } else {
        let title = Regex::new(r"(?m)^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$")
            .unwrap()
            .captures(&text)
            .map(|c| c[1].to_owned())
            .unwrap_or_default();
        (title, text.to_string())
    };
    (normalize(&title), normalize(&body))
}
pub fn scores(item: &Value, spaces: &Value) -> Value {
    let where_ = fold(
        &Path::new(item["relativePath"].as_str().unwrap_or(s(&item["name"])))
            .iter()
            .map(|p| p.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" "),
    );
    let mut title_body = None;
    let mut result = json!({});
    if let Some(spaces) = spaces.as_object() {
        for (key, space) in spaces {
            let mut score = 0;
            for term in arr(&space["terms"]) {
                let term = s(&term);
                if where_.contains(term) {
                    score += 3;
                    continue;
                }
                let (title, body) = title_body.get_or_insert_with(|| head(item));
                if title.contains(term) {
                    score += 2
                } else if body.contains(term) {
                    score += 1
                }
            }
            if score > 0 {
                result[key] = json!(score)
            }
        }
    }
    result
}
pub fn target(item: &Value, routing: &Value, require_match: bool) -> Option<String> {
    let scores = scores(item, &routing["spaces"]);
    let map = scores.as_object().unwrap();
    if let Some(best) = map.values().filter_map(Value::as_i64).max() {
        let winners = map
            .iter()
            .filter(|(_, v)| v.as_i64() == Some(best))
            .collect::<Vec<_>>();
        if winners.len() == 1 {
            return Some(s(&routing["spaces"][winners[0].0]["name"]).to_owned());
        }
    }
    if require_match && map.is_empty() {
        None
    } else {
        routing["fallback"].as_str().map(str::to_owned)
    }
}
pub fn roots(routing: &Value, name: &str) -> Vec<String> {
    let want = fold(name);
    if !routing["spaces"].get(&want).is_some() && want != fold(s(&routing["fallback"])) {
        return vec![];
    }
    arr(&routing["sources"])
        .iter()
        .map(|x| expand(s(&x["path"])).to_string_lossy().into_owned())
        .collect()
}
pub fn routed(routing: &Value, name: &str, warnings: &mut Vec<String>) -> Vec<Value> {
    if name.is_empty() || roots(routing, name).is_empty() {
        return vec![];
    }
    let mut result = vec![];
    for source in arr(&routing["sources"]) {
        let mut entry = json!({"path":source["path"]});
        if source["depth"].as_i64().unwrap_or(0) > 0 {
            entry["depth"] = source["depth"].clone()
        }
        for mut item in documents(&[entry], warnings, true) {
            if target(
                &item,
                routing,
                source["requireMatch"].as_bool().unwrap_or(false),
            )
            .is_some_and(|n| fold(&n) == fold(name))
            {
                let (title, _) = head(&item);
                item["routedFrom"] = json!(expand(s(&source["path"])));
                if !title.is_empty() {
                    item["title"] = json!(title)
                }
                result.push(item)
            }
        }
    }
    result
}
pub fn cli(args: &[String]) -> Result<()> {
    let path = option(args, "--routing")
        .map(expand)
        .unwrap_or_else(|| app_home().join("data/sixfold/project-docs-routing.local.json"));
    let routing = load(&path).ok_or("no routing file")?;
    for source in arr(&routing["sources"]) {
        let mut entry = json!({"path":source["path"]});
        if !source["depth"].is_null() {
            entry["depth"] = source["depth"].clone()
        }
        for doc in documents(&[entry], &mut vec![], true) {
            crate::legacy_text::print_line(&format!(
                "{}\t{}",
                target(
                    &doc,
                    &routing,
                    source["requireMatch"].as_bool().unwrap_or(false)
                )
                .unwrap_or_else(|| "-".into()),
                s(&doc["path"])
            ))?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tie_uses_fallback_but_unmatched_download_hidden() {
        let routing = json!({"fallback":"Share","spaces":{"a":{"name":"A","terms":["alpha"]},"b":{"name":"B","terms":["beta"]}}});
        let item = json!({"path":"/missing.pdf","name":"alpha-beta.pdf"});
        assert_eq!(target(&item, &routing, true), Some("Share".into()));
        assert_eq!(
            target(
                &json!({"path":"/none.pdf","name":"none.pdf"}),
                &routing,
                true
            ),
            None
        );
    }
}
