//! One bounded stdio connection to the core for the lifetime of the collector.
//! `hc connect` owns endpoint/config resolution on every supported platform.
use crate::common::*;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, Sender},
    thread::JoinHandle,
    time::Duration,
};

const MAX_REPLY: u64 = 16 * 1024 * 1024;

pub struct Connection {
    child: Child,
    requests: Option<Sender<String>>,
    replies: Receiver<std::result::Result<String, String>>,
    worker: Option<JoinHandle<()>>,
    serial: u64,
}

impl Connection {
    pub fn start(mut command: Command) -> Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let (request_tx, request_rx) = mpsc::channel::<String>();
        let (reply_tx, reply_rx) = mpsc::channel();
        // Both write and read stay off the waiting thread, so a wedged core
        // cannot block the collection loop on a full pipe in either direction.
        let worker = std::thread::spawn(move || {
            for request in request_rx {
                let reply = (|| -> std::io::Result<String> {
                    input.write_all(request.as_bytes())?;
                    input.flush()?;
                    let mut line = String::new();
                    (&mut output).take(MAX_REPLY + 1).read_line(&mut line)?;
                    if line.len() as u64 > MAX_REPLY || !line.ends_with('\n') {
                        return Err(std::io::Error::other("incomplete or oversized core reply"));
                    }
                    Ok(line)
                })()
                .map_err(|error| error.to_string());
                let failed = reply.is_err();
                if reply_tx.send(reply).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            requests: Some(request_tx),
            replies: reply_rx,
            worker: Some(worker),
            serial: 0,
        })
    }

    pub fn list(&mut self, timeout: Duration) -> Result<Value> {
        self.serial += 1;
        let id = self.serial;
        let request = json!({"jsonrpc":"2.0","id":id,"method":"terminal.list","params":{}});
        self.requests
            .as_ref()
            .ok_or("core connection closed")?
            .send(format!("{request}\n"))?;
        let line = self
            .replies
            .recv_timeout(timeout)?
            .map_err(std::io::Error::other)?;
        let reply: Value = serde_json::from_str(&line)?;
        if reply["jsonrpc"] != "2.0" || reply["id"] != id {
            return Err("unexpected core response envelope".into());
        }
        if reply.get("error").is_some() {
            return Err("core terminal.list failed".into());
        }
        if !reply["result"]["terminals"].is_array() {
            return Err("core terminal.list omitted terminals".into());
        }
        Ok(reply["result"].clone())
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.requests.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
