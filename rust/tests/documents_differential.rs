//! Frozen outputs from the original Python helpers at 8c5b71d.
//! Path-dependent records were captured on Windows; portable pure records run on every OS.
use herdr_theme::documents::{catalog, common::*, install, observers, pins, render, update};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path};

fn bind_original_local_dates(expected: &mut Value, input: &Value) {
    // doc_catalog.py uses datetime.fromtimestamp(ms / 1000), without a timezone
    // argument. The immutable Windows capture used UTC+09; the runner may not.
    // Validate that capture context before rebinding only its calendar fields.
    // Do not use the native result or catalog::modified to derive expectations.
    let captured_zone = chrono::FixedOffset::east_opt(9 * 3600).unwrap();
    let today = chrono::NaiveDate::parse_from_str(s(&input["today"]), "%Y-%m-%d").unwrap();
    let since =
        today - chrono::Duration::days((input["recent_days"].as_i64().unwrap_or(7) - 1).max(0));
    for row in expected.as_array_mut().unwrap() {
        let item = input["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["path"] == row["path"])
            .unwrap();
        assert_eq!(row["mtime"], item["mtime"]);
        let instant =
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(item["mtime"].as_i64().unwrap())
                .unwrap();
        let captured = instant.with_timezone(&captured_zone).date_naive();
        let local = instant.with_timezone(&chrono::Local).date_naive();
        assert_eq!(
            row["modified"],
            captured.to_string(),
            "original capture timezone drift"
        );
        row["modified"] = json!(local.to_string());
        if row["dated"] == false {
            assert_eq!(row["date"], captured.to_string());
            assert_eq!(row["recent"], since <= captured && captured <= today);
            row["date"] = json!(local.to_string());
            row["recent"] = json!(since <= local && local <= today);
        }
    }
}
#[test]
fn original_document_contracts() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/documents-python-baseline.json")).unwrap();
    let mut checked = 0;
    for (index, case) in corpus["cases"].as_array().unwrap().iter().enumerate() {
        let input = &case["input"];
        let function = s(&case["function"]);
        let mut expected = case["expected"].clone();
        let actual = match function {
            "doc_catalog.family_key" => {
                let (a, b, c) = catalog::family_key(s(&input["name"]));
                json!([a, b, c])
            }
            "doc_catalog.label_of" => json!(catalog::label_of(
                s(&input["name"]),
                input["prefix"].as_str()
            )),
            "doc_catalog.common_prefix" => json!(catalog::common_prefix(
                &arr(&input["names"])
                    .iter()
                    .map(|n| s(n).to_owned())
                    .collect::<Vec<_>>()
            )),
            "doc_catalog.kinds_for" => {
                json!(catalog::kinds_for(&input["config"], &input["settings"]))
            }
            "doc_catalog.classify" => {
                if !cfg!(windows) && s(&input["relative"]).contains('\\') {
                    continue;
                }
                json!(catalog::classify(
                    s(&input["name"]),
                    s(&input["relative"]),
                    &arr(&input["kinds"])
                ))
            }
            "doc_catalog.parse_date" => {
                json!(catalog::parse_date(s(&input["text"])).map(|d| d.to_string()))
            }
            "doc_catalog.strip_date" => json!(catalog::strip_date(s(&input["text"]))),
            "doc_catalog.build" => {
                if !cfg!(windows) {
                    continue;
                }
                bind_original_local_dates(&mut expected, input);
                let day = input["today"]
                    .as_str()
                    .map(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").unwrap())
                    .unwrap_or_else(catalog::today);
                json!(catalog::build(
                    &arr(&input["items"]),
                    &arr(&input["pins"]),
                    &arr(&input["kinds"]),
                    day,
                    input["recent_days"].as_i64().unwrap_or(7)
                ))
            }
            "render_html.interactive" => json!(render::interactive(s(&input["text"]))),
            "render_mermaid.mermaid_blocks" => json!(render::mermaid_blocks(s(&input["text"]))),
            "open_doc_tab.docs_tab" => {
                let listing = &input["listing"];
                let found = arr(&listing["spaces"])
                    .into_iter()
                    .find(|sp| sp["id"] == input["space_id"])
                    .and_then(|sp| {
                        arr(&sp["tabs"]).into_iter().find_map(|tab| {
                            tab["id"]
                                .as_str()
                                .filter(|id| id.starts_with("sf-docs-tab-"))
                                .map(str::to_owned)
                        })
                    });
                json!(found)
            }
            "open_doc_tab.choose_space" => {
                if !cfg!(windows) {
                    continue;
                }
                let live = input["live"]
                    .as_array()
                    .map(|a| a.iter().map(|v| s(v).to_owned()).collect::<HashSet<_>>());
                json!(pins::choose_space(
                    &input["config"],
                    Path::new(s(&input["file"])),
                    input["wanted"].as_str(),
                    live.as_ref()
                )
                .unwrap())
            }
            "install_doc_tabs.ensure_document_tabs" => {
                // The absent/empty spaces cases do not generate any platform
                // path, so their omission-preservation contract is portable.
                if !cfg!(windows)
                    && input["document"]
                        .get("spaces")
                        .and_then(Value::as_array)
                        .is_some_and(|spaces| !spaces.is_empty())
                {
                    continue;
                }
                let app = Path::new(s(&input["app_home"]));
                let (mut out, added) = install::ensure_document_tabs(&input["document"], app);
                // Explicit interpreter-removal transport exception. Neither
                // golden paths nor arbitrary existing props are rewritten.
                // Both transports must be independently exact before comparing
                // every remaining document field unchanged.
                let new_ids: HashSet<String> =
                    added.iter().map(|row| s(&row["tab"]).to_owned()).collect();
                if let Some(spaces) = out.get_mut("spaces").and_then(Value::as_array_mut) {
                    for (space_index, space) in spaces.iter_mut().enumerate() {
                        if let Some(tabs) = space.get_mut("tabs").and_then(Value::as_array_mut) {
                            for (tab_index, tab) in tabs.iter_mut().enumerate() {
                                if !new_ids.contains(s(&tab["id"])) {
                                    continue;
                                }
                                let original = &mut expected[0]["spaces"][space_index]["tabs"]
                                    [tab_index]["root"]["content"]["props"];
                                let props = &mut tab["root"]["content"]["props"];
                                let id = original["spaceId"].clone();
                                assert_eq!(
                                    *original,
                                    json!({"spaceId":id,"resolverScript":app.join("scripts").join("sixfold").join("resolve_doc_pins.py"),"installerScript":app.join("scripts").join("sixfold").join("install_doc_tabs.py")})
                                );
                                let binary =
                                    app.join("scripts/sixfold").join(install::native_name());
                                assert_eq!(
                                    *props,
                                    json!({"spaceId":id,"resolverCommand":[binary,"resolve_doc_pins"],"installerCommand":[binary,"install_doc_tabs"]})
                                );
                                let original = original.as_object_mut().unwrap();
                                original.remove("resolverScript");
                                original.remove("installerScript");
                                let props = props.as_object_mut().unwrap();
                                props.remove("resolverCommand");
                                props.remove("installerCommand");
                            }
                        }
                    }
                }
                json!([out, added])
            }
            "update_install.fill_missing" => {
                update::fill_missing(&input["current"], &input["defaults"]).unwrap()
            }
            "install_preview.replace_files" => {
                let mut node = input["node"].clone();
                let found = install::replace_files(&mut node, &input["stack"]);
                json!([found, node])
            }
            "install_space_cleanup.review_findings" => {
                json!(observers::review_findings(s(&input["text"])))
            }
            // seed_config reads live README sources. Those integration cases have dedicated sandbox tests.
            "install_doc_tabs.seed_config" => continue,
            other => panic!("unhandled frozen function {other}"),
        };
        assert_eq!(actual, expected, "case {index}: {function}\ninput={input}");
        checked += 1;
    }
    assert!(
        checked >= 100,
        "too few original contracts executed: {checked}"
    );
}
