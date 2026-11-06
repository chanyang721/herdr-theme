//! CPython 3.12 datetime.fromisoformat grammar used by the replay tool.
//! Acceptance and component facts are frozen from the unchanged C datetime API.
use super::Result;
use chrono::{Datelike, NaiveDate, NaiveDateTime, TimeZone, Weekday};
fn digits(text: &[char]) -> Result<u32> {
    if text.is_empty() || text.iter().any(|c| !c.is_ascii_digit()) {
        return Err("invalid ISO decimal".into());
    }
    Ok(text
        .iter()
        .fold(0, |value, c| value * 10 + (*c as u32 - '0' as u32)))
}
fn separator(s: &[char]) -> Result<usize> {
    let n = s.len();
    if n < 7 {
        return Err("ISO date too short".into());
    }
    if n == 7 {
        return Ok(7);
    }
    Ok(if s[4] == '-' {
        if s[5] == 'W' {
            if n < 8 {
                return Err("invalid ISO week".into());
            }
            if n > 8 && s[8] == '-' {
                if n == 9 {
                    return Err("invalid ISO weekday".into());
                }
                if n > 10 && s[10].is_ascii_digit() {
                    8
                } else {
                    10
                }
            } else {
                8
            }
        } else {
            10
        }
    } else if s[4] == 'W' {
        let mut i = 7;
        while i < n && s[i].is_ascii_digit() {
            i += 1;
        }
        if i < 9 {
            i
        } else if i % 2 == 0 {
            7
        } else {
            8
        }
    } else {
        8
    })
}
fn date(s: &[char]) -> Result<NaiveDate> {
    if ![7, 8, 10].contains(&s.len()) {
        return Err("invalid ISO date length".into());
    }
    let year = digits(&s[..4])? as i32;
    if !(1..=9999).contains(&year) {
        return Err("ISO year out of range".into());
    }
    let dashed = s[4] == '-';
    let mut p = 4 + usize::from(dashed);
    let value = if s[p] == 'W' {
        p += 1;
        let week = digits(s.get(p..p + 2).ok_or("missing ISO week")?)?;
        p += 2;
        let mut day = 1;
        if p < s.len() {
            if (s[p] == '-') != dashed {
                return Err("inconsistent ISO dashes".into());
            }
            p += usize::from(dashed);
            day = digits(s.get(p..p + 1).ok_or("missing ISO weekday")?)?;
            p += 1;
        }
        if p != s.len() {
            return Err("extra ISO date input".into());
        }
        let weekday = match day {
            1 => Weekday::Mon,
            2 => Weekday::Tue,
            3 => Weekday::Wed,
            4 => Weekday::Thu,
            5 => Weekday::Fri,
            6 => Weekday::Sat,
            7 => Weekday::Sun,
            _ => return Err("ISO weekday out of range".into()),
        };
        NaiveDate::from_isoywd_opt(year, week, weekday)
    } else {
        let month = digits(s.get(p..p + 2).ok_or("missing ISO month")?)?;
        p += 2;
        if s.get(p).is_some_and(|c| *c == '-') != dashed {
            return Err("inconsistent ISO dashes".into());
        }
        p += usize::from(dashed);
        let day = digits(s.get(p..p + 2).ok_or("missing ISO day")?)?;
        p += 2;
        if p != s.len() {
            return Err("extra ISO date input".into());
        }
        NaiveDate::from_ymd_opt(year, month, day)
    }
    .ok_or("invalid ISO date")?;
    if !(1..=9999).contains(&value.year()) {
        return Err("ISO date out of range".into());
    }
    Ok(value)
}
fn clock(s: &[char], incomplete_before_zone: bool) -> Result<[u32; 4]> {
    let mut values = [0; 4];
    let mut pos = 0;
    let mut colon = false;
    for component in 0..3 {
        let Some(pair) = s.get(pos..pos + 2) else {
            // C datetime retains completed clock components when a later
            // component is incomplete immediately before a valid timezone.
            if incomplete_before_zone
                && component > 0
                && s[pos..].iter().all(|c| c.is_ascii_digit())
            {
                return Ok(values);
            }
            return Err("incomplete ISO time".into());
        };
        values[component] = digits(pair)?;
        pos += 2;
        if component == 0 {
            colon = s.get(pos) == Some(&':');
        }
        if pos == s.len() || component == 2 || ['.', ','].contains(&s[pos]) {
            break;
        }
        if colon {
            if s[pos] != ':' {
                return Err("invalid ISO time separator".into());
            }
            pos += 1;
        }
    }
    if pos < s.len() {
        if ['.', ','].contains(&s[pos]) {
            pos += 1;
        } else if colon && s[pos] == ':' {
            pos += 1;
            if s.len() - pos < 2 {
                return Err("incomplete fourth ISO component".into());
            }
        } else if !colon && s.len() - pos >= 2 && s[pos].is_ascii_digit() {
        } else {
            return Err("invalid ISO fraction".into());
        }
        let rest = &s[pos..];
        if rest.is_empty() || rest.iter().any(|c| !c.is_ascii_digit()) {
            return Err("invalid ISO fraction".into());
        }
        let len = rest.len().min(6);
        values[3] = digits(&rest[..len])? * 10u32.pow((6 - len) as u32);
    }
    Ok(values)
}
pub fn parse(text: &str) -> Result<(NaiveDateTime, Option<i64>)> {
    let s = text.chars().collect::<Vec<_>>();
    let split = separator(&s)?;
    let day = date(s.get(..split).ok_or("incomplete ISO date")?)?;
    let tail = s.get(split + 1..).unwrap_or(&[]);
    if tail.is_empty() {
        if s.len() > split {
            return Err("missing ISO time".into());
        }
        return Ok((day.and_hms_opt(0, 0, 0).unwrap(), None));
    }
    let zone = tail
        .iter()
        .position(|c| *c == '-')
        .or_else(|| tail.iter().position(|c| *c == '+'))
        .or_else(|| tail.iter().position(|c| *c == 'Z'));
    let raw_clock = &tail[..zone.unwrap_or(tail.len())];
    // The C parser permits a final clock separator immediately before a zone
    // designator, while rejecting the same incomplete unzoned clock.
    let raw_clock = if zone.is_some()
        && raw_clock
            .last()
            .is_some_and(|c| [':', '.', ','].contains(c))
    {
        &raw_clock[..raw_clock.len() - 1]
    } else {
        raw_clock
    };
    let values = clock(raw_clock, zone.is_some())?;
    let offset = if let Some(z) = zone {
        if tail[z] == 'Z' {
            if z + 1 != tail.len() {
                return Err("invalid ISO UTC suffix".into());
            }
            Some(0)
        } else {
            let zone = &tail[z + 1..];
            if [0, 1, 3].contains(&zone.len()) {
                return Err("invalid ISO offset length".into());
            }
            let fields = clock(zone, false)?;
            // The C datetime implementation recognizes an offset with zero
            // whole seconds as UTC, including a nonzero fractional remainder.
            let seconds = fields[0] as i64 * 3600 + fields[1] as i64 * 60 + fields[2] as i64;
            let micros = (seconds * 1_000_000 + if seconds == 0 { 0 } else { fields[3] as i64 })
                * if tail[z] == '-' { -1 } else { 1 };
            if micros.abs() >= 86400_000_000 {
                return Err("ISO offset out of range".into());
            }
            Some(micros)
        }
    } else {
        None
    };
    Ok((
        day.and_hms_micro_opt(values[0], values[1], values[2], values[3])
            .ok_or("invalid ISO time")?,
        offset,
    ))
}
pub fn timestamp(text: &str) -> Result<f64> {
    let (naive, offset) = parse(text)?;
    if let Some(offset) = offset {
        return Ok((naive.and_utc().timestamp_micros() - offset) as f64 / 1_000_000.);
    }
    let local = chrono::Local.from_local_datetime(&naive);
    if let Some(value) = local.earliest() {
        return Ok(value.timestamp() as f64 + value.timestamp_subsec_micros() as f64 / 1_000_000.);
    }
    // CPython fold=0 chooses the later candidate in a local-time gap.
    let mut candidates = vec![];
    for delta in [-86400, 86400] {
        let adjacent = naive + chrono::Duration::seconds(delta);
        if let Some(value) = chrono::Local.from_local_datetime(&adjacent).earliest() {
            candidates.push(naive.and_utc().timestamp() - value.offset().local_minus_utc() as i64);
        }
    }
    let seconds = candidates
        .into_iter()
        .max()
        .ok_or("unresolvable local ISO time")?;
    Ok(seconds as f64 + naive.and_utc().timestamp_subsec_micros() as f64 / 1_000_000.)
}
