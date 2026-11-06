//! Text I/O compatibility for the migrated CPython 3.12 entrypoints.
//!
//! CP949, CP125x and ISO-8859-15 facts are frozen from the untouched standard-library codecs,
//! including byte sequences Windows itself accepts differently. Other legacy
//! codecs use the operating system converter; mapping parity for those codecs
//! is recorded separately from the frozen CP949/CP1252 and Unicode contracts.
use std::{
    collections::BTreeMap,
    error::Error,
    fmt, fs,
    io::{Read, Write},
    path::Path,
    sync::OnceLock,
};
pub type Result<T> = std::result::Result<T, Box<dyn Error>>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorPolicy {
    Strict,
    Ignore,
    BackslashReplace,
    Replace,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Decode,
    Encode,
    Lookup,
}
#[derive(Debug)]
pub struct TextError {
    pub operation: Operation,
    pub encoding: String,
    pub start: usize,
    pub end: usize,
    pub reason: String,
    escaped_fragment: Option<String>,
}
impl TextError {
    pub fn python_class(&self) -> &'static str {
        if self.reason.starts_with("UTF-16 stream") || self.reason.starts_with("UTF-32 stream") {
            return "UnicodeError";
        }
        match self.operation {
            Operation::Decode => "UnicodeDecodeError",
            Operation::Encode => "UnicodeEncodeError",
            Operation::Lookup => "LookupError",
        }
    }
}
impl fmt::Display for TextError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.python_class() == "UnicodeError" {
            return f.write_str(&self.reason);
        }
        match self.operation {
            Operation::Lookup
                if self.reason == "unknown encoding"
                    || self.reason == "unsupported locale codec" =>
            {
                write!(f, "unknown encoding: {}", self.encoding)
            }
            Operation::Lookup => f.write_str(&self.reason),
            Operation::Decode if self.end == self.start + 1 => write!(
                f,
                "'{}' codec can't decode byte {} in position {}: {}",
                self.encoding,
                self.escaped_fragment.as_deref().unwrap_or("?"),
                self.start,
                self.reason
            ),
            Operation::Decode => write!(
                f,
                "'{}' codec can't decode bytes in position {}-{}: {}",
                self.encoding,
                self.start,
                self.end.saturating_sub(1),
                self.reason
            ),
            Operation::Encode if self.end == self.start + 1 => write!(
                f,
                "'{}' codec can't encode character '{}' in position {}: {}",
                self.encoding,
                self.escaped_fragment.as_deref().unwrap_or("?"),
                self.start,
                self.reason
            ),
            Operation::Encode => write!(
                f,
                "'{}' codec can't encode characters in position {}-{}: {}",
                self.encoding,
                self.start,
                self.end.saturating_sub(1),
                self.reason
            ),
        }
    }
}
impl Error for TextError {}
fn failure<T>(
    operation: Operation,
    encoding: &str,
    start: usize,
    end: usize,
    reason: &str,
) -> Result<T> {
    Err(Box::new(TextError {
        operation,
        encoding: encoding.into(),
        start,
        end,
        reason: reason.into(),
        escaped_fragment: None,
    }))
}
fn error_encoding(encoding: &str) -> String {
    match codec(encoding) {
        Ok(Codec::Utf8) | Ok(Codec::Utf8Sig) => "utf-8".into(),
        Ok(Codec::Ascii) => "ascii".into(),
        Ok(Codec::Latin1) => "latin-1".into(),
        Ok(Codec::Cp949) => "cp949".into(),
        Ok(Codec::Cp1252) | Ok(Codec::SingleByte(_)) => "charmap".into(),
        _ => encoding.to_owned(),
    }
}
fn decode_failure<T>(
    bytes: &[u8],
    encoding: &str,
    start: usize,
    end: usize,
    reason: &str,
) -> Result<T> {
    Err(Box::new(TextError {
        operation: Operation::Decode,
        encoding: error_encoding(encoding),
        start,
        end,
        reason: reason.into(),
        escaped_fragment: (end == start + 1).then(|| format!("0x{:02x}", bytes[start])),
    }))
}
fn encode_failure<T>(
    text: &str,
    encoding: &str,
    start: usize,
    end: usize,
    reason: &str,
) -> Result<T> {
    Err(Box::new(TextError {
        operation: Operation::Encode,
        encoding: error_encoding(encoding),
        start,
        end,
        reason: reason.into(),
        escaped_fragment: if end == start + 1 {
            text.chars().nth(start).map(escaped_character)
        } else {
            None
        },
    }))
}
#[derive(Clone, Copy)]
enum Codec {
    Utf8,
    Utf8Sig,
    Utf16(Option<bool>),
    Utf32(Option<bool>),
    Ascii,
    Latin1,
    Cp949,
    Cp1252,
    SingleByte(u16),
    Other,
}
fn codec(name: &str) -> Result<Codec> {
    let mut normalized = String::new();
    let mut punctuation = false;
    for ch in name.chars() {
        if crate::python_unicode::is_alphanumeric(ch) || ch == '.' {
            if punctuation && !normalized.is_empty() {
                normalized.push('_');
            }
            if ch.is_ascii() {
                normalized.push(ch.to_ascii_lowercase());
            }
            punctuation = false;
        } else {
            punctuation = true;
        }
    }
    let name = normalized;
    match name.as_str() {
        "utf_8" | "utf8" | "utf" | "u8" | "cp65001" | "utf8_ucs2" | "utf8_ucs4" => Ok(Codec::Utf8),
        "utf_8_sig" => Ok(Codec::Utf8Sig),
        "utf_16" | "utf16" | "u16" => Ok(Codec::Utf16(None)),
        "utf_16_le" | "utf16le" | "unicodelittleunmarked" => Ok(Codec::Utf16(Some(true))),
        "utf_16_be" | "utf16be" | "unicodebigunmarked" => Ok(Codec::Utf16(Some(false))),
        "utf_32" | "utf32" | "u32" => Ok(Codec::Utf32(None)),
        "utf_32_le" | "utf32le" => Ok(Codec::Utf32(Some(true))),
        "utf_32_be" | "utf32be" => Ok(Codec::Utf32(Some(false))),
        "ascii" | "us_ascii" | "us" | "646" | "ansi_x3.4_1968" | "ansi_x3_4_1968"
        | "ansi_x3.4_1986" | "cp367" | "csascii" | "ibm367" | "iso646_us" | "iso_646.irv_1991"
        | "iso_ir_6" => Ok(Codec::Ascii),
        "latin_1" | "latin1" | "latin" | "l1" | "iso8859_1" | "iso_8859_1" | "iso_8859_1_1987"
        | "iso_ir_100" | "csisolatin1" | "ibm819" | "cp819" | "8859" | "iso8859" => {
            Ok(Codec::Latin1)
        }
        "cp949" | "949" | "ms949" | "uhc" => Ok(Codec::Cp949),
        "cp1252" | "1252" | "windows_1252" => Ok(Codec::Cp1252),
        "iso8859_15" | "iso_8859_15" | "iso_8859_15_2000" | "latin9" | "l9" => {
            Ok(Codec::SingleByte(28605))
        }
        #[cfg(windows)]
        "mbcs" | "ansi" | "dbcs" => codec(&format!("cp{}", unsafe { win::GetACP() })),
        _ => {
            let code = name
                .strip_prefix("cp")
                .or_else(|| name.strip_prefix("windows_"))
                .or_else(|| Some(name.as_str()))
                .and_then(|value| value.parse::<u16>().ok());
            if let Some(code) = code.filter(|code| (1250..=1258).contains(code)) {
                Ok(Codec::SingleByte(code))
            } else {
                Ok(Codec::Other)
            }
        }
    }
}
const CP949: &[u8; 65536] = include_bytes!("legacy_text/cp949.bin");
const CP1252: &[u8; 512] = include_bytes!("legacy_text/cp1252.bin");
fn pair(lead: u8, trail: u8) -> Option<char> {
    let offset = ((lead as usize - 128) * 256 + trail as usize) * 2;
    let point = u16::from_le_bytes([CP949[offset], CP949[offset + 1]]);
    (point != 0).then(|| char::from_u32(point as u32).unwrap())
}
fn single1252(byte: u8) -> Option<char> {
    let offset = byte as usize * 2;
    let point = u16::from_le_bytes([CP1252[offset], CP1252[offset + 1]]);
    (point != 0xffff).then(|| char::from_u32(point as u32).unwrap())
}
fn single_table(code: u16) -> &'static [u8; 512] {
    match code {
        1250 => include_bytes!("legacy_text/cp1250.bin"),
        1251 => include_bytes!("legacy_text/cp1251.bin"),
        1252 => CP1252,
        1253 => include_bytes!("legacy_text/cp1253.bin"),
        1254 => include_bytes!("legacy_text/cp1254.bin"),
        1255 => include_bytes!("legacy_text/cp1255.bin"),
        1256 => include_bytes!("legacy_text/cp1256.bin"),
        1257 => include_bytes!("legacy_text/cp1257.bin"),
        1258 => include_bytes!("legacy_text/cp1258.bin"),
        28605 => include_bytes!("legacy_text/iso885915.bin"),
        _ => unreachable!(),
    }
}
fn single_character(code: u16, byte: u8) -> Option<char> {
    let table = single_table(code);
    let index = byte as usize * 2;
    let point = u16::from_le_bytes([table[index], table[index + 1]]);
    (point != 0xffff).then(|| char::from_u32(point as u32).unwrap())
}
fn single_inverse(code: u16) -> &'static BTreeMap<char, u8> {
    static MAP: OnceLock<BTreeMap<u16, BTreeMap<char, u8>>> = OnceLock::new();
    &MAP.get_or_init(|| {
        [1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258, 28605]
            .into_iter()
            .map(|code| {
                (
                    code,
                    (0..=255)
                        .filter_map(|byte| single_character(code, byte).map(|ch| (ch, byte)))
                        .collect(),
                )
            })
            .collect()
    })[&code]
}
fn inverse949() -> &'static BTreeMap<char, [u8; 2]> {
    static MAP: OnceLock<BTreeMap<char, [u8; 2]>> = OnceLock::new();
    MAP.get_or_init(|| {
        let mut map = BTreeMap::new();
        for lead in 128..=255 {
            for trail in 0..=255 {
                if let Some(ch) = pair(lead, trail) {
                    map.entry(ch).or_insert([lead, trail]);
                }
            }
        }
        map
    })
}
fn inverse1252() -> &'static BTreeMap<char, u8> {
    static MAP: OnceLock<BTreeMap<char, u8>> = OnceLock::new();
    MAP.get_or_init(|| {
        (0..=255)
            .filter_map(|byte| single1252(byte).map(|ch| (ch, byte)))
            .collect()
    })
}
fn invalid_bytes(out: &mut String, bytes: &[u8], policy: ErrorPolicy) {
    if policy == ErrorPolicy::Replace {
        out.push('\u{fffd}');
    }
    if policy == ErrorPolicy::BackslashReplace {
        for byte in bytes {
            out.push_str(&format!("\\x{byte:02x}"));
        }
    }
}
pub fn decode(bytes: &[u8], encoding: &str, policy: ErrorPolicy) -> Result<String> {
    let selected = codec(encoding)?;
    match selected {
        Codec::Utf8Sig => {
            return decode(
                bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes),
                "utf-8",
                policy,
            )
        }
        Codec::Utf16(endian) => return decode_wide(bytes, encoding, policy, 2, endian),
        Codec::Utf32(endian) => return decode_wide(bytes, encoding, policy, 4, endian),
        Codec::Other => return os_decode(bytes, encoding, policy),
        _ => {}
    }
    let mut out = String::new();
    let mut offset = 0;
    while offset < bytes.len() {
        if matches!(selected, Codec::Utf8) {
            match std::str::from_utf8(&bytes[offset..]) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(error) => {
                    let start = offset + error.valid_up_to();
                    out.push_str(std::str::from_utf8(&bytes[offset..start]).unwrap());
                    let end = start + error.error_len().unwrap_or(bytes.len() - start);
                    let reason = if error.error_len().is_none() {
                        "unexpected end of data"
                    } else if (0xc2..=0xf4).contains(&bytes[start]) {
                        "invalid continuation byte"
                    } else {
                        "invalid start byte"
                    };
                    if policy == ErrorPolicy::Strict {
                        return decode_failure(bytes, encoding, start, end, reason);
                    }
                    invalid_bytes(&mut out, &bytes[start..end], policy);
                    offset = end;
                    continue;
                }
            }
        }
        let byte = bytes[offset];
        let (character, length) = match selected {
            Codec::Latin1 => (Some(char::from(byte)), 1),
            Codec::Ascii => ((byte < 128).then_some(char::from(byte)), 1),
            Codec::Cp1252 => (single1252(byte), 1),
            Codec::SingleByte(code) => (single_character(code, byte), 1),
            Codec::Cp949 if byte < 128 => (Some(char::from(byte)), 1),
            Codec::Cp949 if offset + 1 < bytes.len() => (pair(byte, bytes[offset + 1]), 2),
            Codec::Cp949 => (None, 1),
            _ => unreachable!(),
        };
        if let Some(ch) = character {
            out.push(ch);
            offset += length;
        } else {
            let reason = match selected {
                Codec::Ascii => "ordinal not in range(128)",
                Codec::Cp1252 | Codec::SingleByte(_) => "character maps to <undefined>",
                Codec::Cp949 if offset + 1 == bytes.len() => "incomplete multibyte sequence",
                _ => "illegal multibyte sequence",
            };
            if policy == ErrorPolicy::Strict {
                return decode_failure(bytes, encoding, offset, offset + 1, reason);
            }
            invalid_bytes(&mut out, &bytes[offset..offset + 1], policy);
            offset += 1;
        }
    }
    #[cfg(windows)]
    if policy == ErrorPolicy::Strict {
        if let Some(cp) = match selected {
            Codec::Cp949 => Some(949),
            Codec::Cp1252 => Some(1252),
            _ => None,
        } {
            if let Some(native) = win::decode(bytes, cp) {
                if native == out {
                    return Ok(native);
                }
            }
        }
    }
    Ok(out)
}
fn encoded_character(ch: char, selected: Codec) -> Option<Vec<u8>> {
    match selected {
        Codec::Utf8 | Codec::Utf8Sig => Some(ch.to_string().into_bytes()),
        Codec::Ascii => ((ch as u32) < 128).then_some(vec![ch as u8]),
        Codec::Latin1 => ((ch as u32) < 256).then_some(vec![ch as u8]),
        Codec::Cp1252 => inverse1252().get(&ch).map(|byte| vec![*byte]),
        Codec::SingleByte(code) => single_inverse(code).get(&ch).map(|byte| vec![*byte]),
        Codec::Cp949 if (ch as u32) < 128 => Some(vec![ch as u8]),
        Codec::Cp949 => inverse949().get(&ch).map(|pair| pair.to_vec()),
        _ => unreachable!(),
    }
}
fn escaped_character(ch: char) -> String {
    let point = ch as u32;
    if point <= 0xff {
        format!("\\x{point:02x}")
    } else if point <= 0xffff {
        format!("\\u{point:04x}")
    } else {
        format!("\\U{point:08x}")
    }
}
pub fn encode(text: &str, encoding: &str, policy: ErrorPolicy) -> Result<Vec<u8>> {
    let selected = codec(encoding)?;
    if matches!(selected, Codec::Utf8) {
        return Ok(text.as_bytes().to_vec());
    }
    match selected {
        Codec::Utf8Sig => return Ok([&[0xef, 0xbb, 0xbf][..], text.as_bytes()].concat()),
        Codec::Utf16(endian) => return Ok(encode_wide(text, 2, endian)),
        Codec::Utf32(endian) => return Ok(encode_wide(text, 4, endian)),
        Codec::Other => return os_encode(text, encoding, policy),
        _ => {}
    }
    let chars = text.chars().collect::<Vec<_>>();
    let mut out = vec![];
    let mut index = 0;
    while index < chars.len() {
        if let Some(bytes) = encoded_character(chars[index], selected) {
            out.extend(bytes);
            index += 1;
            continue;
        }
        let mut end = index + 1;
        // CPython's single-byte encoders group a contiguous unmappable run;
        // its multibyte CP949 encoder reports one Unicode character at a time.
        if !matches!(selected, Codec::Cp949) {
            while end < chars.len() && encoded_character(chars[end], selected).is_none() {
                end += 1;
            }
        }
        let reason = match selected {
            Codec::Ascii => "ordinal not in range(128)",
            Codec::Latin1 => "ordinal not in range(256)",
            Codec::Cp1252 | Codec::SingleByte(_) => "character maps to <undefined>",
            _ => "illegal multibyte sequence",
        };
        if policy == ErrorPolicy::Strict {
            return encode_failure(text, encoding, index, end, reason);
        }
        if policy == ErrorPolicy::BackslashReplace {
            for ch in &chars[index..end] {
                out.extend(escaped_character(*ch).bytes());
            }
        }
        if policy == ErrorPolicy::Replace {
            out.extend(std::iter::repeat(b'?').take(end - index));
        }
        index = end;
    }
    #[cfg(windows)]
    if policy == ErrorPolicy::Strict {
        if let Some(cp) = match selected {
            Codec::Cp949 => Some(949),
            Codec::Cp1252 => Some(1252),
            _ => None,
        } {
            if let Some(native) = win::encode(text, cp) {
                if native == out {
                    return Ok(native);
                }
            }
        }
    }
    Ok(out)
}
fn os_decode(bytes: &[u8], encoding: &str, policy: ErrorPolicy) -> Result<String> {
    #[cfg(windows)]
    {
        let cp = win::codepage(encoding).ok_or_else(|| {
            Box::new(TextError {
                operation: Operation::Lookup,
                encoding: encoding.into(),
                start: 0,
                end: 0,
                reason: "unknown encoding".into(),
                escaped_fragment: None,
            }) as Box<dyn Error>
        })?;
        if let Some(text) = win::decode(bytes, cp) {
            return Ok(text);
        }
        let mut text = String::new();
        let mut offset = 0;
        while offset < bytes.len() {
            let mut found = None;
            for length in 1..=(bytes.len() - offset).min(8) {
                if let Some(part) = win::decode(&bytes[offset..offset + length], cp) {
                    if !part.is_empty() {
                        found = Some((length, part));
                        break;
                    }
                }
            }
            if let Some((length, part)) = found {
                text.push_str(&part);
                offset += length;
            } else {
                if policy == ErrorPolicy::Strict {
                    return decode_failure(
                        bytes,
                        encoding,
                        offset,
                        offset + 1,
                        "illegal multibyte sequence",
                    );
                }
                invalid_bytes(&mut text, &bytes[offset..offset + 1], policy);
                offset += 1;
            }
        }
        Ok(text)
    }
    #[cfg(not(windows))]
    {
        String::from_utf8(posix::convert(
            bytes,
            encoding,
            "UTF-8",
            encoding,
            Operation::Decode,
            policy,
        )?)
        .map_err(|error| Box::new(error) as Box<dyn Error>)
    }
}
fn os_encode(text: &str, encoding: &str, policy: ErrorPolicy) -> Result<Vec<u8>> {
    #[cfg(windows)]
    {
        let cp = win::codepage(encoding).ok_or_else(|| {
            Box::new(TextError {
                operation: Operation::Lookup,
                encoding: encoding.into(),
                start: 0,
                end: 0,
                reason: "unknown encoding".into(),
                escaped_fragment: None,
            }) as Box<dyn Error>
        })?;
        if let Some(bytes) = win::encode(text, cp) {
            return Ok(bytes);
        }
        let mut bytes = vec![];
        for (index, ch) in text.chars().enumerate() {
            if let Some(part) = win::encode(&ch.to_string(), cp) {
                bytes.extend(part);
            } else {
                if policy == ErrorPolicy::Strict {
                    return encode_failure(
                        text,
                        encoding,
                        index,
                        index + 1,
                        "illegal multibyte sequence",
                    );
                }
                if policy == ErrorPolicy::BackslashReplace {
                    bytes
                        .extend(win::encode(&escaped_character(ch), cp).ok_or_else(|| {
                            std::io::Error::from(std::io::ErrorKind::InvalidData)
                        })?);
                }
                if policy == ErrorPolicy::Replace {
                    bytes
                        .extend(win::encode("?", cp).ok_or_else(|| {
                            std::io::Error::from(std::io::ErrorKind::InvalidData)
                        })?);
                }
            }
        }
        Ok(bytes)
    }
    #[cfg(not(windows))]
    {
        posix::convert(
            text.as_bytes(),
            "UTF-8",
            encoding,
            encoding,
            Operation::Encode,
            policy,
        )
    }
}
fn decode_wide(
    bytes: &[u8],
    _encoding: &str,
    policy: ErrorPolicy,
    width: usize,
    endian: Option<bool>,
) -> Result<String> {
    let mut little = endian.unwrap_or(cfg!(target_endian = "little"));
    let mut offset = 0;
    if endian.is_none() {
        let little_bom = if width == 2 {
            &[0xff, 0xfe][..]
        } else {
            &[0xff, 0xfe, 0, 0][..]
        };
        let big_bom = if width == 2 {
            &[0xfe, 0xff][..]
        } else {
            &[0, 0, 0xfe, 0xff][..]
        };
        if bytes.starts_with(little_bom) {
            little = true;
            offset = width;
        } else if bytes.starts_with(big_bom) {
            little = false;
            offset = width;
        }
    }
    let encoding = format!("utf-{}-{}", width * 8, if little { "le" } else { "be" });
    let mut out = String::new();
    while offset < bytes.len() {
        let mut end = (offset + width).min(bytes.len());
        let mut reason = "truncated data";
        let mut character = None;
        if end - offset == width {
            if width == 2 {
                let unit = if little {
                    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
                } else {
                    u16::from_be_bytes([bytes[offset], bytes[offset + 1]])
                };
                if (0xd800..=0xdbff).contains(&unit) {
                    if bytes.len() - offset < 4 {
                        end = bytes.len();
                        reason = "unexpected end of data";
                    } else {
                        let low = if little {
                            u16::from_le_bytes([bytes[offset + 2], bytes[offset + 3]])
                        } else {
                            u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]])
                        };
                        if (0xdc00..=0xdfff).contains(&low) {
                            end = offset + 4;
                            character = char::from_u32(
                                0x10000 + ((unit as u32 - 0xd800) << 10) + (low as u32 - 0xdc00),
                            );
                        } else {
                            reason = "illegal UTF-16 surrogate";
                        }
                    }
                } else if (0xdc00..=0xdfff).contains(&unit) {
                    reason = "illegal encoding";
                } else {
                    character = char::from_u32(unit as u32);
                }
            } else {
                let array = [
                    bytes[offset],
                    bytes[offset + 1],
                    bytes[offset + 2],
                    bytes[offset + 3],
                ];
                let point = if little {
                    u32::from_le_bytes(array)
                } else {
                    u32::from_be_bytes(array)
                };
                if (0xd800..=0xdfff).contains(&point) {
                    reason = "code point in surrogate code point range(0xd800, 0xe000)";
                } else if point > 0x10ffff {
                    reason = "code point not in range(0x110000)";
                } else {
                    character = char::from_u32(point);
                }
            }
        }
        if let Some(ch) = character {
            out.push(ch);
        } else {
            if policy == ErrorPolicy::Strict {
                return decode_failure(bytes, &encoding, offset, end, reason);
            }
            invalid_bytes(&mut out, &bytes[offset..end], policy);
        }
        offset = end;
    }
    Ok(out)
}
fn encode_wide(text: &str, width: usize, endian: Option<bool>) -> Vec<u8> {
    let little = endian.unwrap_or(cfg!(target_endian = "little"));
    let mut out = vec![];
    if endian.is_none() {
        out.extend(if width == 2 {
            if little {
                vec![0xff, 0xfe]
            } else {
                vec![0xfe, 0xff]
            }
        } else if little {
            vec![0xff, 0xfe, 0, 0]
        } else {
            vec![0, 0, 0xfe, 0xff]
        });
    }
    if width == 2 {
        for unit in text.encode_utf16() {
            out.extend(if little {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
    } else {
        for ch in text.chars() {
            out.extend(if little {
                (ch as u32).to_le_bytes()
            } else {
                (ch as u32).to_be_bytes()
            });
        }
    }
    out
}
pub fn default_encoding() -> String {
    if std::env::var("PYTHONUTF8").ok().as_deref() == Some("1") {
        return "utf-8".into();
    }
    #[cfg(windows)]
    {
        let code = unsafe { win::GetACP() };
        return if code == 65001 {
            "utf-8".into()
        } else {
            format!("cp{code}")
        };
    }
    #[cfg(not(windows))]
    {
        let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
            .iter()
            .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()))
            .unwrap_or_default();
        if locale == "C" || locale == "POSIX" {
            if std::env::var("PYTHONUTF8").ok().as_deref() == Some("0") {
                let coerce = std::env::var("PYTHONCOERCECLOCALE").ok().as_deref() != Some("0")
                    && std::env::var("LC_ALL")
                        .ok()
                        .filter(|value| !value.is_empty())
                        .is_none();
                if coerce
                    && ["C.UTF-8", "C.utf8", "UTF-8"]
                        .iter()
                        .any(|locale| posix::locale_available(locale))
                {
                    return "utf-8".into();
                }
                return "ascii".into();
            }
            return "utf-8".into();
        }
        if let Some(encoding) = posix::locale_encoding() {
            return encoding;
        }
        if let Some((_, encoding)) = locale.split_once('.') {
            return encoding.split('@').next().unwrap_or(encoding).to_owned();
        }
        #[cfg(target_os = "macos")]
        {
            return "utf-8".into();
        }
        #[cfg(not(target_os = "macos"))]
        {
            if locale.is_empty() {
                "utf-8".into()
            } else {
                format!("locale:{locale}")
            }
        }
    }
}
pub fn decode_default(bytes: &[u8], policy: ErrorPolicy) -> Result<String> {
    decode(bytes, &default_encoding(), policy)
}
pub fn encode_default(text: &str, policy: ErrorPolicy) -> Result<Vec<u8>> {
    encode(text, &default_encoding(), policy)
}
pub fn universal_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}
pub fn platform_newlines(text: &str) -> String {
    if cfg!(windows) {
        text.replace('\n', "\r\n")
    } else {
        text.to_owned()
    }
}
pub fn read(path: impl AsRef<Path>, policy: ErrorPolicy) -> Result<String> {
    Ok(universal_newlines(&decode_default(
        &fs::read(path)?,
        policy,
    )?))
}
pub fn write(path: impl AsRef<Path>, text: &str) -> Result<()> {
    // Path.write_text opens/truncates before TextIOWrapper encodes its argument.
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?;
    let bytes = encode_default(&platform_newlines(text), ErrorPolicy::Strict)?;
    file.write_all(&bytes)?;
    Ok(())
}
fn stream_settings(error: bool, input: bool) -> (String, String, bool) {
    let mut encoding = default_encoding();
    #[cfg(windows)]
    let console = win::console_kind(if input {
        -10
    } else if error {
        -12
    } else {
        -11
    });
    #[cfg(not(windows))]
    let console = false;
    let legacy_console = cfg!(windows)
        && std::env::var_os("PYTHONLEGACYWINDOWSSTDIO").is_some_and(|value| !value.is_empty());
    if console && !legacy_console {
        encoding = "utf-8".into();
    }
    let mut handler = if error {
        "backslashreplace".to_owned()
    } else if input && !cfg!(windows) {
        "surrogateescape".to_owned()
    } else {
        "strict".to_owned()
    };
    if let Ok(setting) = std::env::var("PYTHONIOENCODING") {
        let (name, errors) = setting
            .split_once(':')
            .map(|(a, b)| (a, Some(b)))
            .unwrap_or((&setting, None));
        if !name.is_empty() && !(console && !legacy_console) {
            encoding = name.into();
        }
        if !error {
            if let Some(errors) = errors.filter(|value| !value.is_empty()) {
                handler = errors.into();
            }
        }
    }
    (encoding, handler, console && !legacy_console)
}
pub fn stream_encode(text: &str, error: bool) -> Result<Vec<u8>> {
    let (encoding, handler, _) = stream_settings(error, false);
    let text = platform_newlines(text);
    let policy = match handler.as_str() {
        "strict" | "surrogateescape" | "surrogatepass" => Some(ErrorPolicy::Strict),
        "ignore" => Some(ErrorPolicy::Ignore),
        "backslashreplace" => Some(ErrorPolicy::BackslashReplace),
        "replace" => Some(ErrorPolicy::Replace),
        _ => None,
    };
    let bytes = match policy {
        Some(policy) => encode(&text, &encoding, policy)?,
        None => match encode(&text, &encoding, ErrorPolicy::Strict) {
            Ok(bytes) => bytes,
            Err(_) => {
                return failure(
                    Operation::Lookup,
                    &encoding,
                    0,
                    0,
                    &format!("unknown error handler name '{handler}'"),
                )
            }
        },
    };
    Ok(bytes)
}
pub fn read_stdin() -> Result<String> {
    let (encoding, handler, _) = stream_settings(false, true);
    let mut bytes = vec![];
    std::io::stdin().read_to_end(&mut bytes)?;
    let policy = match handler.as_str() {
        "strict" => Some(ErrorPolicy::Strict),
        "ignore" => Some(ErrorPolicy::Ignore),
        "backslashreplace" => Some(ErrorPolicy::BackslashReplace),
        "replace" => Some(ErrorPolicy::Replace),
        _ => None,
    };
    let text = match policy {
        Some(policy) => decode(&bytes, &encoding, policy)?,
        None => match decode(&bytes, &encoding, ErrorPolicy::Strict) {
            Ok(text) => text,
            Err(_) => {
                return failure(
                    Operation::Lookup,
                    &encoding,
                    0,
                    0,
                    "stdin error handler requires unsupported surrogate-aware text",
                )
            }
        },
    };
    // IncrementalDecoder first decodes the bytes, then enforces the BOM once a
    // full unit was consumed. A truncated/illegal unit raises its codec error
    // before the stream-level missing-BOM error.
    let missing = match codec(&encoding)? {
        Codec::Utf16(None) => {
            bytes.len() >= 2
                && !bytes.starts_with(&[0xff, 0xfe])
                && !bytes.starts_with(&[0xfe, 0xff])
        }
        Codec::Utf32(None) => {
            bytes.len() >= 4
                && !bytes.starts_with(&[0xff, 0xfe, 0, 0])
                && !bytes.starts_with(&[0, 0, 0xfe, 0xff])
        }
        _ => false,
    };
    if missing {
        return failure(
            Operation::Decode,
            &encoding,
            0,
            0,
            if matches!(codec(&encoding)?, Codec::Utf16(_)) {
                "UTF-16 stream does not start with BOM"
            } else {
                "UTF-32 stream does not start with BOM"
            },
        );
    }
    Ok(universal_newlines(&text))
}
fn write_stream_bytes(bytes: &[u8], error: bool) -> Result<()> {
    #[cfg(windows)]
    let (_, _, unicode_console) = stream_settings(error, false);
    #[cfg(windows)]
    {
        win::write(bytes, error, unicode_console)?;
    }
    #[cfg(not(windows))]
    {
        if error {
            std::io::stderr().lock().write_all(bytes)?;
        } else {
            std::io::stdout().lock().write_all(bytes)?;
        }
    }
    Ok(())
}
fn stream(text: &str, error: bool) -> Result<()> {
    let bytes = stream_encode(text, error)?;
    let (encoding, _, _) = stream_settings(error, false);
    let bom = match codec(&encoding)? {
        Codec::Utf8Sig => 3,
        Codec::Utf16(None) => 2,
        Codec::Utf32(None) => 4,
        _ => 0,
    };
    if bom == 0 {
        return write_stream_bytes(&bytes, error);
    }
    static INITIALIZED: std::sync::Mutex<[bool; 2]> = std::sync::Mutex::new([false; 2]);
    let mut state = INITIALIZED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let index = usize::from(error);
    write_stream_bytes(if state[index] { &bytes[bom..] } else { &bytes }, error)?;
    state[index] = true;
    Ok(())
}
pub fn stdout(text: &str) -> Result<()> {
    stream(text, false)
}
pub fn stderr(text: &str) -> Result<()> {
    stream(text, true)
}
pub fn print_line(text: &str) -> Result<()> {
    stdout(&format!("{text}\n"))
}
pub fn error_line(text: &str) -> Result<()> {
    stderr(&format!("{text}\n"))
}

#[cfg(not(windows))]
mod posix {
    use super::*;
    use std::ffi::{c_char, c_void, CStr, CString};
    #[cfg_attr(target_os = "macos", link(name = "iconv"))]
    unsafe extern "C" {
        fn iconv_open(to: *const c_char, from: *const c_char) -> *mut c_void;
        fn iconv(
            handle: *mut c_void,
            input: *mut *mut c_char,
            input_left: *mut usize,
            output: *mut *mut c_char,
            output_left: *mut usize,
        ) -> usize;
        fn iconv_close(handle: *mut c_void) -> i32;
    }
    struct Converter(*mut c_void);
    impl Drop for Converter {
        fn drop(&mut self) {
            unsafe {
                iconv_close(self.0);
            }
        }
    }
    fn feed(
        handle: *mut c_void,
        bytes: &[u8],
        out: &mut Vec<u8>,
    ) -> std::result::Result<usize, (usize, i32)> {
        let mut input = bytes.as_ptr() as *mut c_char;
        let mut remaining = bytes.len();
        loop {
            let mut buffer = [0u8; 8192];
            let mut output = buffer.as_mut_ptr() as *mut c_char;
            let mut capacity = buffer.len();
            let result = unsafe {
                iconv(
                    handle,
                    &mut input,
                    &mut remaining,
                    &mut output,
                    &mut capacity,
                )
            };
            let error = if result == usize::MAX {
                std::io::Error::last_os_error()
                    .raw_os_error()
                    .unwrap_or(libc::EILSEQ)
            } else {
                0
            };
            out.extend_from_slice(&buffer[..buffer.len() - capacity]);
            if result != usize::MAX {
                if result > 0 {
                    return Err((bytes.len() - remaining, libc::ENOTSUP));
                }
                return Ok(bytes.len() - remaining);
            }
            if error != libc::E2BIG {
                return Err((bytes.len() - remaining, error));
            }
        }
    }
    pub fn convert(
        input: &[u8],
        from: &str,
        to: &str,
        name: &str,
        operation: Operation,
        policy: ErrorPolicy,
    ) -> Result<Vec<u8>> {
        let from = CString::new(from)
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        let to =
            CString::new(to).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        let handle = unsafe { iconv_open(to.as_ptr(), from.as_ptr()) };
        if handle as usize == usize::MAX {
            return failure(Operation::Lookup, name, 0, 0, "unknown encoding");
        }
        let handle = Converter(handle);
        let mut output = vec![];
        let mut offset = 0;
        while offset < input.len() {
            match feed(handle.0, &input[offset..], &mut output) {
                Ok(_) => {
                    offset = input.len();
                }
                Err((used, error)) => {
                    offset += used;
                    if !matches!(error, libc::EILSEQ | libc::EINVAL) {
                        return Err(std::io::Error::from_raw_os_error(error).into());
                    }
                    let start = if operation == Operation::Encode {
                        std::str::from_utf8(&input[..offset])
                            .unwrap()
                            .chars()
                            .count()
                    } else {
                        offset
                    };
                    let next = if operation == Operation::Encode {
                        offset
                            + std::str::from_utf8(&input[offset..])
                                .unwrap()
                                .chars()
                                .next()
                                .unwrap()
                                .len_utf8()
                    } else if error == libc::EINVAL {
                        input.len()
                    } else {
                        offset + 1
                    };
                    let end = if operation == Operation::Encode {
                        start + 1
                    } else {
                        next
                    };
                    let reason = if error == libc::EINVAL {
                        "incomplete multibyte sequence"
                    } else {
                        "illegal multibyte sequence"
                    };
                    if policy == ErrorPolicy::Strict {
                        return if operation == Operation::Decode {
                            decode_failure(input, name, start, end, reason)
                        } else {
                            encode_failure(
                                std::str::from_utf8(input).unwrap(),
                                name,
                                start,
                                end,
                                reason,
                            )
                        };
                    }
                    if policy == ErrorPolicy::BackslashReplace {
                        if operation == Operation::Decode {
                            for byte in &input[offset..next] {
                                output.extend(format!("\\x{byte:02x}").bytes());
                            }
                        } else {
                            let escaped = escaped_character(
                                std::str::from_utf8(&input[offset..next])
                                    .unwrap()
                                    .chars()
                                    .next()
                                    .unwrap(),
                            );
                            feed(handle.0, escaped.as_bytes(), &mut output).map_err(|_| {
                                std::io::Error::from(std::io::ErrorKind::InvalidData)
                            })?;
                        }
                    }
                    if policy == ErrorPolicy::Replace {
                        if operation == Operation::Decode {
                            output.extend("\u{fffd}".as_bytes());
                        } else {
                            feed(handle.0, b"?", &mut output).map_err(|_| {
                                std::io::Error::from(std::io::ErrorKind::InvalidData)
                            })?;
                        }
                    }
                    offset = next;
                }
            }
        }
        // Flush shift state, as a complete Python encode/decode operation does.
        loop {
            let mut buffer = [0u8; 128];
            let mut next = buffer.as_mut_ptr() as *mut c_char;
            let mut left = buffer.len();
            let result = unsafe {
                iconv(
                    handle.0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut next,
                    &mut left,
                )
            };
            let error = if result == usize::MAX {
                std::io::Error::last_os_error()
                    .raw_os_error()
                    .unwrap_or(libc::EILSEQ)
            } else {
                0
            };
            output.extend_from_slice(&buffer[..buffer.len() - left]);
            if result != usize::MAX {
                break;
            }
            if error != libc::E2BIG {
                return Err(std::io::Error::from_raw_os_error(error).into());
            }
        }
        Ok(output)
    }
    pub fn locale_encoding() -> Option<String> {
        // uselocale changes this thread only; never mutate the process locale.
        let locale =
            unsafe { libc::newlocale(libc::LC_CTYPE_MASK, c"".as_ptr(), std::ptr::null_mut()) };
        if locale.is_null() {
            return None;
        }
        let previous = unsafe { libc::uselocale(locale) };
        if previous.is_null() {
            unsafe {
                libc::freelocale(locale);
            }
            return None;
        }
        let pointer = unsafe { libc::nl_langinfo(libc::CODESET) };
        let result = if pointer.is_null() {
            None
        } else {
            Some(
                unsafe { CStr::from_ptr(pointer) }
                    .to_string_lossy()
                    .into_owned(),
            )
        };
        unsafe {
            libc::uselocale(previous);
            libc::freelocale(locale);
        }
        result
    }
    pub fn locale_available(name: &str) -> bool {
        let Ok(name) = CString::new(name) else {
            return false;
        };
        let locale =
            unsafe { libc::newlocale(libc::LC_CTYPE_MASK, name.as_ptr(), std::ptr::null_mut()) };
        if locale.is_null() {
            false
        } else {
            unsafe {
                libc::freelocale(locale);
            }
            true
        }
    }
}

#[cfg(windows)]
mod win {
    use std::{ffi::c_void, ptr};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn GetACP() -> u32;
        fn IsValidCodePage(cp: u32) -> i32;
        fn MultiByteToWideChar(
            cp: u32,
            flags: u32,
            input: *const u8,
            length: i32,
            output: *mut u16,
            capacity: i32,
        ) -> i32;
        fn WideCharToMultiByte(
            cp: u32,
            flags: u32,
            input: *const u16,
            length: i32,
            output: *mut u8,
            capacity: i32,
            default: *const u8,
            used_default: *mut i32,
        ) -> i32;
        fn GetStdHandle(kind: u32) -> *mut c_void;
        fn GetConsoleMode(handle: *mut c_void, mode: *mut u32) -> i32;
        fn WriteFile(
            handle: *mut c_void,
            bytes: *const u8,
            length: u32,
            written: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
        fn WriteConsoleW(
            handle: *mut c_void,
            text: *const u16,
            length: u32,
            written: *mut u32,
            reserved: *mut c_void,
        ) -> i32;
    }
    pub fn decode(bytes: &[u8], cp: u32) -> Option<String> {
        if bytes.is_empty() {
            return Some(String::new());
        }
        let length = i32::try_from(bytes.len()).ok()?;
        let flags = if zero_flags(cp) { 0 } else { 8 };
        let size =
            unsafe { MultiByteToWideChar(cp, flags, bytes.as_ptr(), length, ptr::null_mut(), 0) };
        if size == 0 {
            return None;
        }
        let mut output = vec![0u16; size as usize];
        if unsafe {
            MultiByteToWideChar(cp, flags, bytes.as_ptr(), length, output.as_mut_ptr(), size)
        } != size
        {
            return None;
        }
        String::from_utf16(&output).ok()
    }
    pub fn encode(text: &str, cp: u32) -> Option<Vec<u8>> {
        if text.is_empty() {
            return Some(vec![]);
        }
        let input = text.encode_utf16().collect::<Vec<_>>();
        let length = i32::try_from(input.len()).ok()?;
        let mut used = 0;
        let flags = if cp == 54936 || cp == 65001 {
            0x80
        } else if zero_flags(cp) {
            0
        } else {
            0x400
        };
        let used_pointer = if matches!(cp, 65000 | 65001 | 54936) {
            ptr::null_mut()
        } else {
            &mut used
        };
        let size = unsafe {
            WideCharToMultiByte(
                cp,
                flags,
                input.as_ptr(),
                length,
                ptr::null_mut(),
                0,
                ptr::null(),
                used_pointer,
            )
        };
        if size == 0 || used != 0 {
            return None;
        }
        let mut output = vec![0; size as usize];
        if unsafe {
            WideCharToMultiByte(
                cp,
                flags,
                input.as_ptr(),
                length,
                output.as_mut_ptr(),
                size,
                ptr::null(),
                used_pointer,
            )
        } != size
            || used != 0
        {
            return None;
        }
        Some(output)
    }
    fn zero_flags(cp: u32) -> bool {
        matches!(
            cp,
            42 | 50220 | 50221 | 50222 | 50225 | 50227 | 50229 | 65000
        ) || (57002..=57011).contains(&cp)
    }
    pub fn codepage(encoding: &str) -> Option<u32> {
        let name = encoding.to_ascii_lowercase().replace(['-', '_', ' '], "");
        let cp = match name.as_str() {
            "shiftjis" | "sjis" | "mskanji" | "ms932" | "windows31j" => 932,
            "gbk" | "ms936" => 936,
            "gb2312" => 20936,
            "big5" | "big5tw" => 950,
            "euckr" | "ksc5601" | "ksc56011987" => 51949,
            "eucjp" => 51932,
            "gb18030" => 54936,
            "iso2022jp" => 50220,
            "utf7" | "u7" => 65000,
            _ => name
                .strip_prefix("cp")
                .unwrap_or(&name)
                .parse::<u32>()
                .ok()?,
        };
        (cp != 0 && unsafe { IsValidCodePage(cp) } != 0).then_some(cp)
    }
    fn handle(error: bool) -> *mut c_void {
        unsafe { GetStdHandle(if error { -12i32 } else { -11i32 } as u32) }
    }
    pub fn console_kind(kind: i32) -> bool {
        let mut mode = 0;
        unsafe { GetConsoleMode(GetStdHandle(kind as u32), &mut mode) != 0 }
    }
    pub fn write(bytes: &[u8], error: bool, unicode_console: bool) -> std::io::Result<()> {
        if unicode_console {
            let text = std::str::from_utf8(bytes)
                .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData))?
                .encode_utf16()
                .collect::<Vec<_>>();
            let mut offset = 0;
            while offset < text.len() {
                let mut length = (text.len() - offset).min(16384);
                if offset + length < text.len()
                    && (0xd800..=0xdbff).contains(&text[offset + length - 1])
                {
                    length -= 1;
                }
                let length = length as u32;
                let mut written = 0;
                if unsafe {
                    WriteConsoleW(
                        handle(error),
                        text[offset..].as_ptr(),
                        length,
                        &mut written,
                        ptr::null_mut(),
                    )
                } == 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                if written == 0 {
                    return Err(std::io::ErrorKind::WriteZero.into());
                }
                offset += written as usize;
            }
            return Ok(());
        }
        let mut offset = 0;
        while offset < bytes.len() {
            let length = (bytes.len() - offset).min(u32::MAX as usize) as u32;
            let mut written = 0;
            if unsafe {
                WriteFile(
                    handle(error),
                    bytes[offset..].as_ptr(),
                    length,
                    &mut written,
                    ptr::null_mut(),
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            if written == 0 {
                return Err(std::io::ErrorKind::WriteZero.into());
            }
            offset += written as usize;
        }
        Ok(())
    }
}
