//! The updater catches Ctrl-C like the original Python BaseException rollback.
use crate::documents::common::Result;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
static INSTALLED: OnceLock<std::result::Result<(), String>> = OnceLock::new();
static ACTIVE: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);
static ROLLING_BACK: AtomicBool = AtomicBool::new(false);
pub struct Scope;
impl Scope {
    pub fn enter() -> Result<Self> {
        INSTALLED
            .get_or_init(|| {
                ctrlc::set_handler(|| {
                    if ACTIVE.load(Ordering::SeqCst) {
                        CANCELLED.store(true, Ordering::SeqCst);
                    } else {
                        std::process::exit(130);
                    }
                })
                .map_err(|error| error.to_string())
            })
            .as_ref()
            .map_err(|error| error.clone())?;
        CANCELLED.store(false, Ordering::SeqCst);
        ACTIVE.store(true, Ordering::SeqCst);
        Ok(Self)
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::SeqCst);
    }
}
pub fn requested() -> bool {
    ACTIVE.load(Ordering::SeqCst)
        && CANCELLED.load(Ordering::SeqCst)
        && !ROLLING_BACK.load(Ordering::SeqCst)
}
pub fn check() -> Result<()> {
    if requested() {
        Err(interruption())
    } else {
        Ok(())
    }
}
#[derive(Debug)]
struct Interrupted;
impl std::fmt::Display for Interrupted {
    fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        Ok(())
    }
}
impl std::error::Error for Interrupted {}
pub fn interruption() -> Box<dyn std::error::Error> {
    Box::new(Interrupted)
}
pub struct Rollback;
impl Rollback {
    pub fn enter() -> Self {
        ROLLING_BACK.store(true, Ordering::SeqCst);
        Self
    }
}
impl Drop for Rollback {
    fn drop(&mut self) {
        ROLLING_BACK.store(false, Ordering::SeqCst);
    }
}
