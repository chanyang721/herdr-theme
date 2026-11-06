//! Native platform verification, with explicit OpenSSL-style environment stores.
//!
//! On Unix/OpenSSL the provider loads SSL_CERT_FILE/DIR itself, including AUX
//! trust purposes. Windows and macOS keep their platform roots and supplement
//! them with explicitly configured ordinary certificates. Directory entries use
//! OpenSSL's canonical subject-name index, rather than trusting arbitrary PEMs.
//! This does not replace TLS chain, validity, purpose or hostname verification.
use crate::common::Result;
use base64::Engine;
use sha1::{Digest, Sha1};
use std::{collections::BTreeSet, io, path::Path};

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Supplemental roots only; built-in platform roots remain enabled.
pub fn roots() -> Result<Vec<reqwest::Certificate>> {
    #[cfg(not(any(windows, target_os = "macos")))]
    return Ok(Vec::new());
    #[cfg(any(windows, target_os = "macos"))]
    {
        let mut result = Vec::new();
        if let Some(file) = std::env::var_os("SSL_CERT_FILE") {
            // OpenSSL's default-path loader ignores absent/unreadable defaults.
            if let Ok(bytes) = std::fs::read(file) {
                let parsed = pem_certificates(&bytes);
                if !parsed.malformed {
                    for cert in parsed.certificates {
                        result.push(platform_certificate(&cert)?);
                    }
                }
            }
        }
        if let Some(paths) = std::env::var_os("SSL_CERT_DIR") {
            let mut seen = BTreeSet::new();
            for dir in std::env::split_paths(&paths).filter(|p| !p.as_os_str().is_empty()) {
                if seen.insert(dir.clone()) {
                    for cert in directory_certificates(&dir)? {
                        result.push(platform_certificate(&cert)?);
                    }
                }
            }
        }
        Ok(result)
    }
}

pub fn async_builder() -> Result<reqwest::ClientBuilder> {
    let mut builder = reqwest::Client::builder().use_native_tls();
    for cert in roots()? {
        builder = builder.add_root_certificate(cert);
    }
    Ok(builder)
}

pub fn blocking_builder() -> Result<reqwest::blocking::ClientBuilder> {
    let mut builder = reqwest::blocking::Client::builder().use_native_tls();
    for cert in roots()? {
        builder = builder.add_root_certificate(cert);
    }
    Ok(builder)
}

#[derive(Debug, Clone)]
struct StoreCertificate {
    der: Vec<u8>,
    subject_hash: String,
    self_issued: bool,
    constrained_aux: bool,
}

#[cfg(any(windows, target_os = "macos"))]
fn platform_certificate(cert: &StoreCertificate) -> Result<reqwest::Certificate> {
    // native-tls has no X509_STORE or AUX purpose/reject API. Never turn a
    // rejected certificate or an untrusted intermediate into a platform root.
    // These cases remain an explicit migration limitation on these providers.
    if cert.constrained_aux {
        return Err(invalid("native TLS cannot preserve OpenSSL AUX trust/reject purposes").into());
    }
    if !cert.self_issued {
        return Err(
            invalid("native TLS cannot preserve an OpenSSL intermediate-only trust entry").into(),
        );
    }
    Ok(reqwest::Certificate::from_der(&cert.der)?)
}

/// OpenSSL 3 default paths install both by_dir (contiguous .0/.1) and by_store
/// (subject-hash filenames with any decimal suffix). Preserve their union;
/// trusting arbitrary PEM basenames would be broader than either lookup.
fn directory_certificates(dir: &Path) -> Result<Vec<StoreCertificate>> {
    let mut hashes = BTreeSet::new();
    let mut store_entries = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if let Some((hash, suffix)) = name.split_once('.') {
                if hash.len() == 8
                    && hash.bytes().all(|b| b.is_ascii_hexdigit())
                    && !suffix.is_empty()
                    && suffix.bytes().all(|b| b.is_ascii_digit())
                {
                    store_entries.push((hash.to_ascii_lowercase(), entry.path()));
                }
            }
            if let Some(hash) = name.strip_suffix(".0") {
                if hash.len() == 8
                    && hash
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    hashes.insert(hash.to_owned());
                }
            }
        }
    }
    let mut result = Vec::new();
    for hash in hashes {
        let mut index: u32 = 0;
        loop {
            let Ok(bytes) = std::fs::read(dir.join(format!("{hash}.{index}"))) else {
                break;
            };
            let parsed = pem_certificates(&bytes);
            let loaded = !parsed.certificates.is_empty();
            // Successfully parsed certificates before a malformed suffix are
            // already in OpenSSL's store, even though loading returns failure.
            result.extend(
                parsed
                    .certificates
                    .into_iter()
                    .filter(|c| c.subject_hash == hash),
            );
            if parsed.malformed || !loaded {
                break;
            }
            let Some(next) = index.checked_add(1) else {
                break;
            };
            index = next;
        }
    }
    // X509_LOOKUP_store uses the directory provider in its native enumeration
    // order, matches the hash case-insensitively and does not require suffix0.
    // A failed selected file stops that subject's store walk. The by_dir cache
    // above remains available even if the provider walk subsequently fails.
    let mut failed = BTreeSet::new();
    for (hash, path) in store_entries {
        if failed.contains(&hash) {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else {
            failed.insert(hash);
            continue;
        };
        let parsed = pem_certificates(&bytes);
        let loaded = !parsed.certificates.is_empty();
        result.extend(
            parsed
                .certificates
                .into_iter()
                .filter(|c| c.subject_hash == hash),
        );
        if parsed.malformed || !loaded {
            failed.insert(hash);
        }
    }
    Ok(result)
}

#[derive(Default)]
struct PemCertificates {
    certificates: Vec<StoreCertificate>,
    malformed: bool,
}

fn pem_certificates(bytes: &[u8]) -> PemCertificates {
    let mut result = PemCertificates::default();
    let mut remaining = bytes;
    const BEGIN: &[u8] = b"-----BEGIN ";
    while let Some(start) = remaining.windows(BEGIN.len()).position(|p| p == BEGIN) {
        remaining = &remaining[start + BEGIN.len()..];
        let Some(end_label) = remaining.windows(5).position(|p| p == b"-----") else {
            break;
        };
        let label = &remaining[..end_label];
        let mut end = b"-----END ".to_vec();
        end.extend_from_slice(label);
        end.extend_from_slice(b"-----");
        remaining = &remaining[end_label + 5..];
        let Some(end_data) = remaining.windows(end.len()).position(|p| p == end) else {
            result.malformed = true;
            break;
        };
        let data = &remaining[..end_data];
        remaining = &remaining[end_data + end.len()..];
        if label != b"CERTIFICATE"
            && label != b"TRUSTED CERTIFICATE"
            && label != b"X509 CERTIFICATE"
        {
            continue;
        }
        let encoded: Vec<u8> = data
            .iter()
            .copied()
            .filter(|b| !b.is_ascii_whitespace())
            .collect();
        let parsed = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| invalid("invalid PEM certificate"))
            .and_then(|der| parse_store_certificate(&der));
        match parsed {
            Ok(cert) => result.certificates.push(cert),
            Err(_) => {
                result.malformed = true;
                break;
            }
        }
    }
    result
}

/// Bounded definite-length DER reader, used only for indexing and metadata.
/// The native TLS implementation still validates the certificate itself.
#[derive(Clone, Copy)]
struct Tlv<'a> {
    tag: u8,
    value: &'a [u8],
    encoded: &'a [u8],
}
fn tlv<'a>(input: &mut &'a [u8]) -> io::Result<Tlv<'a>> {
    let original = *input;
    if original.len() < 2 || original[0] & 31 == 31 {
        return Err(invalid("invalid DER tag"));
    }
    let mut cursor = 2;
    let length = if original[1] < 128 {
        original[1] as usize
    } else {
        let count = (original[1] & 127) as usize;
        if count == 0 || count > std::mem::size_of::<usize>() || original.len() < 2 + count {
            return Err(invalid("invalid DER length"));
        }
        let mut n = 0usize;
        for b in &original[2..2 + count] {
            n = n
                .checked_mul(256)
                .and_then(|n| n.checked_add(*b as usize))
                .ok_or_else(|| invalid("DER length overflow"))?;
        }
        cursor += count;
        n
    };
    let end = cursor
        .checked_add(length)
        .filter(|n| *n <= original.len())
        .ok_or_else(|| invalid("truncated DER"))?;
    *input = &original[end..];
    Ok(Tlv {
        tag: original[0],
        value: &original[cursor..end],
        encoded: &original[..end],
    })
}
fn expected<'a>(input: &mut &'a [u8], tag: u8) -> io::Result<Tlv<'a>> {
    let value = tlv(input)?;
    if value.tag != tag {
        return Err(invalid("unexpected DER tag"));
    }
    Ok(value)
}
fn parse_store_certificate(bytes: &[u8]) -> io::Result<StoreCertificate> {
    let mut rest = bytes;
    let certificate = expected(&mut rest, 0x30)?;
    let mut fields = certificate.value;
    let tbs = expected(&mut fields, 0x30)?;
    expected(&mut fields, 0x30)?;
    expected(&mut fields, 0x03)?;
    if !fields.is_empty() {
        return Err(invalid("extra certificate fields"));
    }
    let mut fields = tbs.value;
    if fields.first() == Some(&0xa0) {
        expected(&mut fields, 0xa0)?;
    }
    expected(&mut fields, 0x02)?;
    expected(&mut fields, 0x30)?;
    let issuer = expected(&mut fields, 0x30)?;
    expected(&mut fields, 0x30)?;
    let subject = expected(&mut fields, 0x30)?;
    let canonical = canonical_name(subject.encoded)?;
    let issuer = canonical_name(issuer.encoded)?;
    let digest = Sha1::digest(&canonical);
    let subject_hash = format!(
        "{:08x}",
        u32::from_le_bytes(digest[..4].try_into().unwrap())
    );
    let mut constrained_aux = false;
    if !rest.is_empty() {
        let auxiliary = expected(&mut rest, 0x30)?;
        if !rest.is_empty() {
            return Err(invalid("extra AUX fields"));
        }
        let mut fields = auxiliary.value;
        while !fields.is_empty() {
            let field = tlv(&mut fields)?;
            if matches!(field.tag, 0x30 | 0xa0) && !field.value.is_empty() {
                constrained_aux = true;
            }
            if !matches!(field.tag, 0x30 | 0xa0 | 0x0c | 0x04 | 0xa1) {
                return Err(invalid("invalid AUX field"));
            }
        }
    }
    Ok(StoreCertificate {
        der: certificate.encoded.to_vec(),
        subject_hash,
        self_issued: canonical == issuer,
        constrained_aux,
    })
}

fn der(tag: u8, value: &[u8]) -> Vec<u8> {
    let mut result = vec![tag];
    if value.len() < 128 {
        result.push(value.len() as u8);
    } else {
        let len = value.len().to_be_bytes();
        let nonzero = len.iter().position(|b| *b != 0).unwrap();
        result.push(0x80 | (len.len() - nonzero) as u8);
        result.extend_from_slice(&len[nonzero..]);
    }
    result.extend_from_slice(value);
    result
}

/// OpenSSL 3 X509_NAME_hash_ex canonical-name algorithm. Independent Rust
/// implementation of documented DER/string semantics; SHA1 is an index only.
/// Primary sources: crypto/x509/{x_name.c,x509_cmp.c,by_dir.c} in OpenSSL 3.0.18.
pub fn subject_name_hash(name_der: &[u8]) -> io::Result<String> {
    let digest = Sha1::digest(canonical_name(name_der)?);
    Ok(format!(
        "{:08x}",
        u32::from_le_bytes(digest[..4].try_into().unwrap())
    ))
}
fn canonical_name(name_der: &[u8]) -> io::Result<Vec<u8>> {
    if name_der.len() > 1024 * 1024 {
        return Err(invalid("X509 name exceeds 1 MiB"));
    }
    let mut outer = name_der;
    let name = expected(&mut outer, 0x30)?;
    if !outer.is_empty() {
        return Err(invalid("extra X509 name bytes"));
    }
    let mut entries = name.value;
    let mut output = Vec::new();
    while !entries.is_empty() {
        let rdn = expected(&mut entries, 0x31)?;
        let mut attrs = rdn.value;
        let mut sorted = Vec::new();
        while !attrs.is_empty() {
            let attr = expected(&mut attrs, 0x30)?;
            let mut fields = attr.value;
            let oid = expected(&mut fields, 0x06)?;
            let value = tlv(&mut fields)?;
            // X509_NAME_ENTRY's ASN1_PRINTABLE multi-string mask is narrower
            // than the canonicalizer's mask (notably it excludes VisibleString).
            if !matches!(value.tag, 3 | 12 | 18 | 19 | 20 | 22 | 28 | 30 | 0x30) {
                return Err(invalid("unsupported X509 name attribute type"));
            }
            if !fields.is_empty() {
                return Err(invalid("extra X509 name attribute"));
            }
            let mut entry = oid.encoded.to_vec();
            entry.extend(canonical_string(value)?);
            sorted.push(der(0x30, &entry));
        }
        sorted.sort();
        output.extend(der(0x31, &sorted.concat()));
    }
    Ok(output)
}
fn canonical_string(value: Tlv<'_>) -> io::Result<Vec<u8>> {
    let utf8 = match value.tag {
        12 => {
            std::str::from_utf8(value.value).map_err(|_| invalid("invalid name UTF8"))?;
            value.value.to_vec()
        }
        19 | 20 | 22 | 26 => value
            .value
            .iter()
            .map(|b| char::from(*b))
            .collect::<String>()
            .into_bytes(),
        30 | 28 => {
            let width = if value.tag == 30 { 2 } else { 4 };
            if value.value.len() % width != 0 {
                return Err(invalid("invalid wide name string"));
            }
            let mut s = String::new();
            for chunk in value.value.chunks_exact(width) {
                let n = chunk.iter().fold(0u32, |n, b| n * 256 + *b as u32);
                s.push(char::from_u32(n).ok_or_else(|| invalid("invalid name codepoint"))?);
            }
            s.into_bytes()
        }
        _ => return Ok(value.encoded.to_vec()),
    };
    let is_space = |b: u8| matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 11 | 12);
    let mut result = Vec::new();
    let mut pending_space = false;
    for b in utf8 {
        if is_space(b) {
            pending_space = !result.is_empty();
        } else {
            if pending_space {
                result.push(b' ');
                pending_space = false;
            }
            result.push(b.to_ascii_lowercase());
        }
    }
    Ok(der(12, &result))
}
