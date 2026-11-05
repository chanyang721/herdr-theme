//! CPython 3.12 Unicode-15 character semantics used by migrated status parsers.
//! This is deliberately a small class adapter, not a general Python regex engine.
mod data;
use std::sync::OnceLock;
fn contains(ranges: &[(u32, u32)], ch: char) -> bool {
    let value = ch as u32;
    let i = ranges.partition_point(|(_, end)| *end < value);
    ranges.get(i).is_some_and(|(start, _)| *start <= value)
}
pub fn is_word(ch: char) -> bool {
    contains(data::WORD, ch)
}
pub fn is_alphanumeric(ch: char) -> bool {
    ch != '_' && is_word(ch)
}
pub fn is_decimal(ch: char) -> bool {
    contains(data::DECIMAL, ch)
}
pub fn is_space(ch: char) -> bool {
    contains(data::SPACE, ch)
}
pub fn decimal_ascii(text: &str) -> String {
    text.chars()
        .map(|ch| {
            let value = ch as u32;
            let i = data::DECIMAL.partition_point(|(_, end)| *end < value);
            if let Some((start, _)) = data::DECIMAL.get(i).filter(|(start, _)| *start <= value) {
                char::from_u32('0' as u32 + (value - start) % 10).unwrap()
            } else {
                ch
            }
        })
        .collect()
}
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}
pub fn split_whitespace(text: &str) -> Vec<&str> {
    text.split(is_space).filter(|s| !s.is_empty()).collect()
}
pub fn split_lines(text: &str) -> Vec<&str> {
    let mut rows = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((i, ch)) = chars.next() {
        if matches!(
            ch,
            '\n' | '\r'
                | '\u{b}'
                | '\u{c}'
                | '\u{1c}'
                | '\u{1d}'
                | '\u{1e}'
                | '\u{85}'
                | '\u{2028}'
                | '\u{2029}'
        ) {
            rows.push(&text[start..i]);
            start = i + ch.len_utf8();
            if ch == '\r' && chars.peek().is_some_and(|(_, c)| *c == '\n') {
                let (i, c) = chars.next().unwrap();
                start = i + c.len_utf8();
            }
        }
    }
    if start < text.len() {
        rows.push(&text[start..]);
    }
    rows
}
pub fn word_boundary(text: &str, at: usize) -> bool {
    debug_assert!(text.is_char_boundary(at));
    text[..at].chars().next_back().is_some_and(is_word)
        != text[at..].chars().next().is_some_and(is_word)
}
fn body(ranges: &[(u32, u32)]) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    for (start, end) in ranges {
        if start == end {
            write!(out, "\\x{{{start:x}}}").unwrap();
        } else {
            write!(out, "\\x{{{start:x}}}-\\x{{{end:x}}}").unwrap();
        }
    }
    out
}
fn class(kind: char) -> &'static str {
    static WORD: OnceLock<String> = OnceLock::new();
    static DECIMAL: OnceLock<String> = OnceLock::new();
    static SPACE: OnceLock<String> = OnceLock::new();
    match kind.to_ascii_lowercase() {
        'w' => WORD.get_or_init(|| body(data::WORD)),
        'd' => DECIMAL.get_or_init(|| body(data::DECIMAL)),
        's' => SPACE.get_or_init(|| body(data::SPACE)),
        _ => unreachable!(),
    }
}
pub fn translate_classes(pattern: &str) -> String {
    let mut out = String::new();
    let mut chars = pattern.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        let Some(escaped) = chars.next() else {
            out.push('\\');
            break;
        };
        if matches!(escaped, 'w' | 'W' | 'd' | 'D' | 's' | 'S') {
            out.push('[');
            if escaped.is_ascii_uppercase() {
                out.push('^');
            }
            out.push_str(class(escaped));
            out.push(']');
        } else {
            out.push('\\');
            out.push(escaped);
        }
    }
    out
}
/// Translate only character classes. Callers using Python word boundaries for
/// substitutions must use `sub`; Rust's built-in Unicode word class is different.
pub fn regex(pattern: &str) -> regex::Regex {
    // Only small original expressions enter this bounded cache; translated
    // Unicode classes are shared by cheap Regex clones. User-sized patterns do
    // not grow the cache, and a poisoned lock does not change parser semantics.
    static CACHE: OnceLock<std::sync::Mutex<std::collections::BTreeMap<String, regex::Regex>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeMap::new()));
    if pattern.len() <= 512 {
        if let Some(found) = cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(pattern)
            .cloned()
        {
            return found;
        }
    }
    let compiled =
        regex::Regex::new(&translate_classes(pattern)).expect("static Python class expression");
    if pattern.len() <= 512 {
        let mut guard = cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard.len() < 64 {
            guard
                .entry(pattern.into())
                .or_insert_with(|| compiled.clone());
        }
    }
    compiled
}
fn unescaped_suffix_boundary(pattern: &str) -> bool {
    if !pattern.ends_with('b') {
        return false;
    }
    pattern[..pattern.len() - 1]
        .chars()
        .rev()
        .take_while(|c| *c == '\\')
        .count()
        % 2
        == 1
}
/// Existing masking expressions use only a leading/trailing `\b`. Remove those
/// assertions from the regex and check the exact frozen Python word class at the
/// match span. Invalid candidates advance one character, preserving overlapping
/// later candidates instead of swallowing them with a greedy invalid match.
pub fn sub(pattern: &str, text: &str, replacement: &str) -> String {
    let mut flags = "";
    let mut body = pattern;
    if pattern.starts_with("(?") {
        if let Some(end) = pattern.find(')') {
            let flag_text = &pattern[2..end];
            if !flag_text.is_empty() && flag_text.chars().all(|c| "imsxU-".contains(c)) {
                flags = &pattern[..=end];
                body = &pattern[end + 1..];
            }
        }
    }
    let start_boundary = body.starts_with(r"\b");
    if start_boundary {
        body = &body[2..];
    }
    let end_boundary = unescaped_suffix_boundary(body);
    if end_boundary {
        body = &body[..body.len() - 2];
    }
    assert!(
        !body.contains(r"\b") && !body.contains(r"\B"),
        "curated Python masking expressions may use only endpoint word boundaries"
    );
    let regex = regex(&format!("{flags}{body}"));
    let (mut search, mut copied) = (0, 0);
    let mut out = String::new();
    while search <= text.len() {
        let Some(captures) = regex.captures_at(text, search) else {
            break;
        };
        let matched = captures.get(0).unwrap();
        let valid = (!start_boundary || word_boundary(text, matched.start()))
            && (!end_boundary || word_boundary(text, matched.end()));
        if !valid {
            if matched.start() == text.len() {
                break;
            }
            search = matched.start() + text[matched.start()..].chars().next().unwrap().len_utf8();
            continue;
        }
        out.push_str(&text[copied..matched.start()]);
        captures.expand(replacement, &mut out);
        copied = matched.end();
        if matched.end() > matched.start() {
            search = matched.end()
        } else {
            if matched.end() == text.len() {
                break;
            }
            search = matched.end() + text[matched.end()..].chars().next().unwrap().len_utf8();
        }
    }
    out.push_str(&text[copied..]);
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn python_decimal_digits_map_to_ascii_without_numeric_lookalikes() {
        assert_eq!(decimal_ascii("१٢3𝟜"), "1234");
        assert_eq!(decimal_ascii("²¼\u{1e5f2}"), "²¼\u{1e5f2}");
    }
    #[test]
    fn word_property_matches_python_not_perl_word() {
        for c in ['²', '¼', '한', '_'] {
            assert!(is_word(c));
        }
        for c in [
            '\u{301}',
            '\u{200c}',
            '\u{200d}',
            '\u{203f}',
            '\u{1c89}',
            '\u{1e5f2}',
            '\u{2ebf0}',
        ] {
            assert!(!is_word(c));
        }
    }
    #[test]
    fn frozen_space_and_splitlines() {
        assert!(is_space('\u{1c}'));
        assert!(is_space('\u{1f}'));
        assert_eq!(
            split_lines("a\u{85}b\u{2028}c\r\nd\r"),
            vec!["a", "b", "c", "d"]
        );
        assert_eq!(split_lines("a\u{1f}b"), vec!["a\u{1f}b"]);
        assert_eq!(split_lines(""), Vec::<&str>::new());
        assert_eq!(split_lines("\n"), vec![""]);
    }
    #[test]
    fn masking_boundaries_use_python_word_and_allow_overlap() {
        let opaque = "A".repeat(24);
        assert_eq!(
            sub(
                r"\b[A-Za-z0-9_\-+/=]{24,}\b",
                &format!("{opaque}\u{301}"),
                "<masked>"
            ),
            "<masked>\u{301}"
        );
        assert_eq!(
            sub(
                r"\b(bearer|basic)\s+\S+",
                "xbearer y-bearer secret",
                "$1 <masked>"
            ),
            "xbearer y-bearer <masked>"
        );
    }
}
