//! Native equivalent of the pinned Workspace Mods counters (including remote reads).
use crate::common::*;
use serde_json::{json, Value};
const WINDOWS:&str="powershell -NoProfile -NonInteractive -Command \"$c=(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average;$o=Get-CimInstance Win32_OperatingSystem;Write-Output (\\\"WIN {0} {1} {2}\\\" -f $c,$o.FreePhysicalMemory,$o.TotalVisibleMemorySize)\"";
const MACOS:&str="sh -c 'echo MAC; /usr/bin/top -l 2 -s 1 -n 0 | grep \"CPU usage\" | tail -1; /usr/bin/vm_stat; /usr/sbin/sysctl -n hw.memsize'";
fn round1(v: f64) -> f64 {
    format!("{v:.1}").parse().unwrap_or(v)
}
pub fn parse_windows(text: &str) -> Option<Value> {
    let re = regex::Regex::new(r"WIN\s+([\d.]+)\s+(\d+)\s+(\d+)").ok()?;
    let f = re.captures(text)?;
    let cpu: f64 = f[1].parse().ok()?;
    let free: i64 = f[2].parse().ok()?;
    let total: i64 = f[3].parse().ok()?;
    if total <= 0 {
        return None;
    }
    Some(
        json!({"cpu":round1(cpu.clamp(0.,100.)),"memory":(total-free)*1024,"total":total*1024,"memoryDefinition":"physical memory in use (total - available)"}),
    )
}
pub fn parse_macos(text: &str) -> Option<Value> {
    if !text.contains("MAC") {
        return None;
    }
    let re = regex::Regex::new(r"CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle").ok()?;
    let cpu = re.captures_iter(text).last()?;
    let re = regex::Regex::new(r"page size of (\d+) bytes").ok()?;
    let page: u64 = re.captures(text)?[1].parse().ok()?;
    let re = regex::Regex::new(r"(?m)^(\d{8,})\s*$").ok()?;
    let total: u64 = re.captures_iter(text).last()?[1].parse().ok()?;
    let re = regex::Regex::new(r"(?m)^([^:\n]+):\s+(\d+)\.").ok()?;
    let mut used = 0u64;
    for cap in re.captures_iter(text) {
        if [
            "Pages active",
            "Pages wired down",
            "Pages occupied by compressor",
        ]
        .contains(&&cap[1])
        {
            used += cap[2].parse::<u64>().ok()?;
        }
    }
    Some(
        json!({"cpu":round1(100.-cpu[3].parse::<f64>().ok()?),"memory":used*page,"total":total,"memoryDefinition":"active + wired + compressed physical pages"}),
    )
}
fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for d in std::env::split_paths(&path) {
        for ext in if cfg!(windows) {
            vec![".exe", ".cmd", ".bat", ""]
        } else {
            vec![""]
        } {
            let p = d.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    None
}
fn remote(machine: &str) -> Value {
    if !regex::Regex::new(r"^[A-Za-z0-9._-]{1,64}$")
        .unwrap()
        .is_match(machine)
    {
        return json!({"error":"Invalid machine name"});
    }
    let hc = which("herdr-core")
        .or_else(|| which("hc"))
        .unwrap_or("hc".into());
    for (cmd, parser) in [
        (WINDOWS, parse_windows as fn(&str) -> Option<Value>),
        (MACOS, parse_macos),
    ] {
        let Ok((code, out, _)) = capture(&hc, &strings(&["exec", "--on", machine, cmd]), 20.)
        else {
            return json!({"error":format!("{machine}: unreachable")});
        };
        if code == 0 {
            if let Some(mut reading) = parser(&out) {
                reading["machine"] = machine.into();
                return reading;
            }
        }
    }
    json!({"error":format!("{machine}: metrics unavailable")})
}
#[cfg(windows)]
fn windows_sample(interval: f64) -> Result<Value> {
    #[repr(C)]
    #[derive(Default)]
    struct Time {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Memory {
        length: u32,
        load: u32,
        total: u64,
        available: u64,
        total_page: u64,
        available_page: u64,
        total_virtual: u64,
        available_virtual: u64,
        extended: u64,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemTimes(idle: *mut Time, kernel: *mut Time, user: *mut Time) -> i32;
        fn GlobalMemoryStatusEx(status: *mut Memory) -> i32;
    }
    fn times() -> Result<(u64, u64)> {
        let (mut idle, mut kernel, mut user) = (Time::default(), Time::default(), Time::default());
        if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
            return Err(
                format!("GetSystemTimes failed: {}", std::io::Error::last_os_error()).into(),
            );
        }
        let value = |t: Time| ((t.high as u64) << 32) | t.low as u64;
        Ok((value(idle), value(kernel) + value(user)))
    }
    let (a, b) = times()?;
    std::thread::sleep(std::time::Duration::from_secs_f64(interval));
    let (c, d) = times()?;
    let elapsed = d.saturating_sub(b);
    if elapsed == 0 {
        return Err("CPU sample unavailable".into());
    }
    let cpu = (100. * (1. - c.saturating_sub(a) as f64 / elapsed as f64)).clamp(0., 100.);
    let mut m = Memory::default();
    m.length = std::mem::size_of::<Memory>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut m) } == 0 {
        return Err(format!(
            "GlobalMemoryStatusEx failed: {}",
            std::io::Error::last_os_error()
        )
        .into());
    }
    Ok(
        json!({"cpu":round1(cpu),"memory":m.total-m.available,"total":m.total,"memoryDefinition":"physical memory in use (total - available)"}),
    )
}
fn sample() -> Result<Value> {
    #[cfg(windows)]
    {
        windows_sample(1.)
    }
    #[cfg(target_os = "macos")]
    {
        let top = output(
            "/usr/bin/top",
            &strings(&["-l", "2", "-s", "1", "-n", "0"]),
            6.,
        )?;
        let vm = output("/usr/bin/vm_stat", &[], 6.)?;
        let total = output("/usr/sbin/sysctl", &strings(&["-n", "hw.memsize"]), 6.)?;
        parse_macos(&format!("MAC\n{top}\n{vm}\n{total}"))
            .ok_or_else(|| "CPU sample unavailable".into())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Ok(json!({"error":"System metrics currently supports macOS and Windows only"}))
    }
}
pub fn run(args: &[String]) -> Result<()> {
    let reading = if let Some(machine) = option(args, "--machine") {
        remote(&machine)
    } else {
        sample().unwrap_or_else(|e| json!({"error":e.to_string()}))
    };
    print(&reading)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_samples_preserve_units_bounds_and_definitions() {
        assert_eq!(
            parse_windows("WIN 123.3 20 100").unwrap(),
            json!({"cpu":100.,"memory":81920,"total":102400,"memoryDefinition":"physical memory in use (total - available)"})
        );
        assert!(parse_windows("WIN 5 20 0").is_none());
        let text="MAC\nCPU usage: 20.0% user, 5.0% sys, 75.0% idle\nMach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: 2.\nPages wired down: 3.\nPages occupied by compressor: 4.\nPages free: 999.\n17179869184\n";
        assert_eq!(parse_macos(text).unwrap()["memory"], 147456);
        assert_eq!(parse_macos(text).unwrap()["cpu"], 25.);
        assert!(parse_macos("No stats").is_none());
        assert_eq!(remote("bad/name"), json!({"error":"Invalid machine name"}));
    }
}
