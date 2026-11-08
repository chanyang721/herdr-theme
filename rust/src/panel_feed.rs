//! Read-only display data. Motion preference is supplied by the producer.
//! The producer owns all interpretation of tasks and relationships.
use crate::common::{self, Result};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

pub const MAX_FEED_BYTES: u64 = 2 * 1024 * 1024;

pub fn default_path() -> PathBuf {
    std::env::var_os("HERDR_PANEL_FEED")
        .map(PathBuf::from)
        .unwrap_or_else(|| select_default(&common::data()))
}

fn select_default(root: &Path) -> PathBuf {
    root.join("task-feed.json")
}

fn read_feed(path: &Path) -> (&'static str, Option<Value>) {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return ("missing", None),
        Err(_) => return ("invalid", None),
    };
    if !metadata.is_file() || metadata.len() > MAX_FEED_BYTES {
        return ("invalid", None);
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A path replaced by a FIFO between metadata and open must not block.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return ("missing", None),
        Err(_) => return ("invalid", None),
    };
    // Refuse directories and special files. A configured FIFO must not hold a
    // sidebar refresh open, and a file growing during the read remains bounded.
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => return ("invalid", None),
    };
    if !metadata.is_file() || metadata.len() > MAX_FEED_BYTES {
        return ("invalid", None);
    }
    let mut bytes = Vec::new();
    if file
        .take(MAX_FEED_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_FEED_BYTES
    {
        return ("invalid", None);
    }
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return ("invalid", None),
    };
    if !value.is_object()
        || value["v"].as_u64() != Some(1)
        || !value["at"].is_string()
        || !value["computers"].is_array()
        || !value["spaces"].is_array()
    {
        return ("invalid", None);
    }
    ("ready", Some(value))
}

/// Neither a read failure nor an unknown producer preference grants permission to
/// change state. Consumers retain their last valid display on missing/invalid.
pub fn snapshot(path: &Path) -> Value {
    let (status, feed) = read_feed(path);
    let reduced_motion = feed
        .as_ref()
        .and_then(|value| value["reduced_motion"].as_bool());
    json!({"feed": feed, "status": status, "reduced_motion": reduced_motion})
}

pub fn cli(args: &[String]) -> Result<()> {
    let mut path = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--help" | "-h" => {
                println!("herdr-theme panel-feed [--path PATH]\nRead the local panel feed and its supplied motion preference without changing either.");
                return Ok(());
            }
            "--path" if index + 1 < args.len() => {
                path = Some(PathBuf::from(&args[index + 1]));
                index += 2;
            }
            _ => return common::usage("usage: herdr-theme panel-feed [--path PATH]"),
        }
    }
    common::print(&snapshot(&path.unwrap_or_else(default_path)))
}
