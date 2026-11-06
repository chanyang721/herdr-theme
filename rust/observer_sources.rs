//! Observer approvals track their production implementation, not the linked
//! application's unrelated commands, debug metadata, toolchain or test code.
pub const COMMON: &[&str] = &[
    "src/observers/mod.rs",
    "src/observers/sessions.rs",
    "src/observers/jobs.rs",
    "src/observers/spaces.rs",
    "src/common.rs",
    "src/locking.rs",
    "src/python_unicode.rs",
    "src/python_unicode/data.rs",
    "src/documents/casefold.rs",
    "src/automation/format.rs",
    "src/automation/printable.rs",
];
pub const SLEEP: &[&str] = &["src/observers/sleep.rs", "src/observers/stub.rs"];

pub fn production_source(text: &str) -> String {
    let mut out = String::new();
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        if line.trim() == "#[cfg(test)]" {
            let next = lines.next().expect("cfg(test) item");
            if next.trim().starts_with("mod ") && next.trim().ends_with(';') {
                continue;
            }
            // Inline test modules in these explicitly listed files are final.
            assert!(next.trim() == "mod tests {", "unexpected test boundary");
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}
