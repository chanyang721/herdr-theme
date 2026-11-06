//! CPython json.loads byte encoding detection, independent of locale text IO.
use crate::common::Result;
use serde_json::Value;
pub fn loads(bytes: &[u8]) -> Result<Value> {
    // json.loads(bytes) detects UTF-8/16/32 independently of the locale.
    let (width, little, offset) = if bytes.starts_with(&[0, 0, 254, 255]) {
        (4, false, 4)
    } else if bytes.starts_with(&[255, 254, 0, 0]) {
        (4, true, 4)
    } else if bytes.starts_with(&[254, 255]) {
        (2, false, 2)
    } else if bytes.starts_with(&[255, 254]) {
        (2, true, 2)
    } else if bytes.starts_with(&[239, 187, 191]) {
        (1, false, 3)
    } else if bytes.len() >= 4 && bytes[0] == 0 {
        (if bytes[1] == 0 { 4 } else { 2 }, false, 0)
    } else if bytes.len() >= 4 && bytes[1] == 0 {
        (if bytes[2] == 0 && bytes[3] == 0 { 4 } else { 2 }, true, 0)
    } else if bytes.len() >= 2 && bytes[0] == 0 {
        (2, false, 0)
    } else if bytes.len() >= 2 && bytes[1] == 0 {
        (2, true, 0)
    } else {
        (1, false, 0)
    };
    let data = &bytes[offset..];
    if width == 1 {
        return Ok(serde_json::from_str(&crate::legacy_text::decode(
            data,
            "utf-8",
            crate::legacy_text::ErrorPolicy::Strict,
        )?)?);
    }
    if data.len() % width != 0 {
        return Err("truncated UTF JSON bytes".into());
    }
    let text = if width == 2 {
        let units = data.chunks_exact(2).map(|b| {
            if little {
                u16::from_le_bytes([b[0], b[1]])
            } else {
                u16::from_be_bytes([b[0], b[1]])
            }
        });
        char::decode_utf16(units).collect::<std::result::Result<String, _>>()?
    } else {
        data.chunks_exact(4)
            .map(|b| {
                let word = [b[0], b[1], b[2], b[3]];
                char::from_u32(if little {
                    u32::from_le_bytes(word)
                } else {
                    u32::from_be_bytes(word)
                })
                .ok_or("invalid UTF-32 JSON scalar")
            })
            .collect::<std::result::Result<String, _>>()?
    };
    Ok(serde_json::from_str(&text)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_json_uses_unicode_detection_instead_of_default_locale() {
        let text = "{\"foreground\":{\"pid\":42},\"name\":\"한국어🎙\"}";
        let expected: Value = serde_json::from_str(text).unwrap();
        assert_eq!(loads(text.as_bytes()).unwrap(), expected);
        for little in [false, true] {
            for bom in [false, true] {
                let mut utf16 = if bom {
                    if little {
                        vec![255, 254]
                    } else {
                        vec![254, 255]
                    }
                } else {
                    vec![]
                };
                for word in text.encode_utf16() {
                    utf16.extend(if little {
                        word.to_le_bytes()
                    } else {
                        word.to_be_bytes()
                    });
                }
                assert_eq!(loads(&utf16).unwrap(), expected);
                let mut utf32 = if bom {
                    if little {
                        vec![255, 254, 0, 0]
                    } else {
                        vec![0, 0, 254, 255]
                    }
                } else {
                    vec![]
                };
                for ch in text.chars() {
                    let word = ch as u32;
                    utf32.extend(if little {
                        word.to_le_bytes()
                    } else {
                        word.to_be_bytes()
                    });
                }
                assert_eq!(loads(&utf32).unwrap(), expected);
            }
        }
    }
}
