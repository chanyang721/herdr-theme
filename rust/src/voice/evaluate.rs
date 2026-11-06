//! Offline tools preserve the original datasets, scenes, seeds and metrics.
//! They never open a microphone or mutate the installed voice state.
use super::{gate, native, policy, rng::Rng, round, settings, Exit, Result};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path, time::Instant};
const RATE: usize = 16000;
fn evaluation_compact(value: &Value) -> String {
    match value {
        Value::String(text) => {
            let mut result = String::new();
            for character in serde_json::to_string(text).unwrap().chars() {
                if character as u32 >= 127 {
                    for word in character.to_string().encode_utf16() {
                        result.push_str(&format!("\\u{word:04x}"));
                    }
                } else {
                    result.push(character);
                }
            }
            result
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(evaluation_compact)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Object(items) => format!(
            "{{{}}}",
            items
                .iter()
                .map(|(key, value)| format!(
                    "{}: {}",
                    evaluation_compact(&json!(key)),
                    evaluation_compact(value)
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Number(number) if number.is_f64() => crate::automation::format::repr(value),
        _ => value.to_string(),
    }
}
fn evaluation_json(value: &Value, depth: usize) -> String {
    let indent = " ".repeat(depth + 1);
    let close = " ".repeat(depth);
    match value {
        Value::Array(items) if !items.is_empty() => format!(
            "[\n{}\n{close}]",
            items
                .iter()
                .map(|item| format!("{indent}{}", evaluation_json(item, depth + 1)))
                .collect::<Vec<_>>()
                .join(",\n")
        ),
        Value::Object(items) if !items.is_empty() => format!(
            "{{\n{}\n{close}}}",
            items
                .iter()
                .map(|(key, item)| format!(
                    "{indent}{}: {}",
                    evaluation_compact(&json!(key)),
                    evaluation_json(item, depth + 1)
                ))
                .collect::<Vec<_>>()
                .join(",\n")
        ),
        Value::Number(number) if number.is_f64() => crate::automation::format::repr(value),
        _ => evaluation_compact(value),
    }
}
fn evaluation_write(path: &Path, value: &Value) -> Result<()> {
    let text = evaluation_json(value, 0);
    crate::legacy_text::write(path, &text)
}
fn evaluation_stderr(text: &str) -> Result<()> {
    crate::legacy_text::error_line(text)
}
fn vad_stdout(row: &Value) -> String {
    let repr = crate::automation::format::repr;
    let recall = [-26, -36, -46, -52, -58, -64]
        .iter()
        .map(|db| format!("{db}: {}", repr(&row["recall"][db.to_string()])))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{{'noise_floor_db': {}, 'threshold': {}, 'boost_db': {}, 'false_seconds_per_minute': {}, 'recall': {{{recall}}}}}", repr(&row["noise_floor_db"]), repr(&row["threshold"]), repr(&row["boost_db"]), repr(&row["false_seconds_per_minute"]))
}
/// Explicit-input model validation: no microphone, default-device lookup,
/// user settings, app focus or installed state is read or modified.
pub fn model_probe(args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        crate::legacy_text::print_line(&format!("herdr-theme voice_model_probe --model MODEL.onnx --vad SILERO.onnx --audio MONO_16K_PCM16.wav --library SHERPA_C_API_LIBRARY --blas PINNED_BLAS_LIBRARY [--threshold 0.35] [--gain 10]"))?;
        return Ok(());
    }
    let model = Path::new(option(args, "--model").ok_or("--model is required")?);
    let vad = Path::new(option(args, "--vad").ok_or("--vad is required")?);
    let audio = Path::new(option(args, "--audio").ok_or("--audio is required")?);
    let library = option(args, "--library").ok_or("--library is required")?;
    let blas = option(args, "--blas").ok_or("--blas is required")?;
    let threshold = option(args, "--threshold")
        .unwrap_or("0.35")
        .parse::<f64>()?;
    let gain = option(args, "--gain").unwrap_or("10").parse::<f64>()?;
    if !threshold.is_finite() || !(0. ..=1.).contains(&threshold) || !gain.is_finite() || gain <= 0.
    {
        return Err("invalid VAD threshold or gain".into());
    }
    std::env::set_var("HERDR_SHERPA_LIBRARY", library);
    std::env::set_var("HERDR_BLAS_LIBRARY", blas);
    let samples = wav(audio)?;
    let engine = native::Engine::load(model, vad, threshold)?;
    let embedding = engine.embed(&samples)?;
    let mut segments = vec![];
    fn drain(engine: &native::Engine, gain: f64, segments: &mut Vec<Value>) -> Result<()> {
        while let Some(segment) = engine.take_segment()? {
            let samples: Vec<f32> = segment.samples.iter().map(|n| *n / gain as f32).collect();
            let embedding = engine.embed(&samples)?;
            segments.push(json!({"start":segment.start,"sample_count":samples.len(),"samples":samples,"embedding":embedding}));
        }
        Ok(())
    }
    for block in samples.chunks(512) {
        let gained: Vec<_> = block.iter().map(|x| *x * gain as f32).collect();
        engine.accept(&gained)?;
        drain(&engine, gain, &mut segments)?;
    }
    engine.flush()?;
    drain(&engine, gain, &mut segments)?;
    let mut decisions = vec![];
    if let Some(input) = option(args, "--decisions") {
        let cases: Value = serde_json::from_slice(&fs::read(input)?)?;
        for case in cases.as_array().ok_or("decision input must be an array")? {
            let count = case["sample_count"]
                .as_u64()
                .ok_or("decision sample_count missing")? as usize;
            if count == 0 || count > samples.len() {
                return Err("decision sample_count out of bounds".into());
            }
            let voiceprint = gate::vector(&case["voiceprint"]);
            if voiceprint.len() != embedding.len() {
                return Err("decision voiceprint dimension mismatch".into());
            }
            let cut = case["threshold"]
                .as_f64()
                .ok_or("decision threshold missing")?;
            let measured = engine.embed(&samples[..count])?;
            let score = gate::dot(&measured, &voiceprint);
            let seconds = count as f64 / RATE as f64;
            decisions.push(json!({"label":case["label"],"seconds":seconds,"score":score,"me":gate::judged(seconds,score,cut)}));
        }
    }
    let matrices = if let Some(path) = option(args, "--matrices") {
        Some(super::linalg::probe(&serde_json::from_slice(&fs::read(
            path,
        )?)?)?)
    } else {
        None
    };
    crate::legacy_text::print_line(&format!(
        "{}",
        json!({"schema":1,"backend":"sherpa-onnx","version":native::SHERPA_VERSION,"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"sample_rate":RATE,"sample_count":samples.len(),"threshold":threshold,"gain":gain,"embedding":embedding,"segments":segments,"decisions":decisions,"matrices":matrices,"abi":native::abi_layout()})
    ))?;
    Ok(())
}
#[derive(PartialEq, Eq, PartialOrd, Ord, Clone, Debug)]
enum Speaker {
    Number(i128),
    Text(String),
}
#[derive(Default)]
struct Dataset {
    speakers: BTreeMap<Speaker, Vec<Vec<f32>>>,
    encounter_order: Vec<Speaker>,
}
impl Dataset {
    fn new() -> Self {
        Self::default()
    }
    fn entry(&mut self, speaker: Speaker) -> &mut Vec<Vec<f32>> {
        if !self.speakers.contains_key(&speaker) {
            self.encounter_order.push(speaker.clone());
        }
        self.speakers.entry(speaker).or_default()
    }
    fn retain_long_enough(&mut self) {
        self.speakers
            .retain(|_, clips| clips.iter().map(Vec::len).sum::<usize>() >= 75 * RATE);
        self.encounter_order
            .retain(|speaker| self.speakers.contains_key(speaker));
    }
    fn values(&self) -> impl Iterator<Item = &Vec<Vec<f32>>> {
        self.encounter_order
            .iter()
            .map(|speaker| &self.speakers[speaker])
    }
    fn sorted_values(&self) -> impl Iterator<Item = &Vec<Vec<f32>>> {
        self.speakers.values()
    }
    fn keys(&self) -> impl Iterator<Item = &Speaker> {
        self.speakers.keys()
    }
    fn len(&self) -> usize {
        self.speakers.len()
    }
}
impl std::ops::Index<&Speaker> for Dataset {
    type Output = Vec<Vec<f32>>;
    fn index(&self, speaker: &Speaker) -> &Self::Output {
        &self.speakers[speaker]
    }
}
fn arg<'a>(args: &'a [String], i: usize) -> Result<&'a str> {
    args.get(i)
        .map(String::as_str)
        .ok_or_else(|| "missing evaluation argument".into())
}
fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}
fn glob_extension(path: &Path, extension: &str, windows: bool) -> bool {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
    {
        return false;
    }
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            if windows {
                value.eq_ignore_ascii_case(extension)
            } else {
                value == extension
            }
        })
}
fn glob_files(directory: &Path, extension: &str) -> Vec<std::path::PathBuf> {
    let mut paths: Vec<_> = fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| glob_extension(path, extension, cfg!(windows)))
        .collect();
    paths.sort();
    paths
}
fn decode(bytes: Vec<u8>) -> Result<Vec<f32>> {
    super::audio::decode(&bytes)
}
fn load(data_dir: &Path) -> Result<Dataset> {
    use parquet::{
        file::reader::{FileReader, SerializedFileReader},
        record::Field,
    };
    let paths = glob_files(data_dir, "parquet");
    let mut speakers = Dataset::new();
    for path in paths {
        let reader = SerializedFileReader::new(fs::File::open(path)?)?;
        for row in reader.get_row_iter(None)? {
            let row = row?;
            let mut speaker = None;
            let mut audio = None;
            for (name, field) in row.get_column_iter() {
                match (name.as_str(), field) {
                    ("speaker_id", Field::Byte(n)) => speaker = Some(Speaker::Number(*n as i128)),
                    ("speaker_id", Field::Short(n)) => speaker = Some(Speaker::Number(*n as i128)),
                    ("speaker_id", Field::UByte(n)) => speaker = Some(Speaker::Number(*n as i128)),
                    ("speaker_id", Field::UShort(n)) => speaker = Some(Speaker::Number(*n as i128)),
                    ("speaker_id", Field::UInt(n)) => speaker = Some(Speaker::Number(*n as i128)),
                    ("speaker_id", Field::ULong(n)) => speaker = Some(Speaker::Number(*n as i128)),
                    ("speaker_id", Field::Bool(n)) => speaker = Some(Speaker::Number(*n as i128)),
                    ("speaker_id", Field::Long(n)) => speaker = Some(Speaker::Number(*n as i128)),
                    ("speaker_id", Field::Int(n)) => speaker = Some(Speaker::Number(*n as i128)),
                    ("speaker_id", Field::Str(s)) => speaker = Some(Speaker::Text(s.clone())),
                    ("audio", Field::Group(group)) => {
                        audio = group.get_column_iter().find_map(|(name, f)| {
                            if name == "bytes" {
                                if let Field::Bytes(b) = f {
                                    Some(b.data().to_vec())
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        });
                    }
                    _ => {}
                }
            }
            let speaker = speaker.ok_or("parquet row lacks speaker_id")?;
            let clips = speakers.entry(speaker);
            if clips.len() < 40 {
                clips.push(decode(audio.ok_or("parquet audio lacks bytes")?)?);
            }
        }
    }
    speakers.retain_long_enough();
    Ok(speakers)
}
pub fn dataset_probe(data_dir: &Path) -> Result<Value> {
    let data = load(data_dir)?;
    let record = |speaker: &Speaker| {
        let clips = &data[speaker];
        let label = match speaker {
            Speaker::Number(number) => number.to_string(),
            Speaker::Text(text) => text.clone(),
        };
        json!({"speaker":label,"clips":clips.len(),"sample_counts":clips.iter().map(Vec::len).collect::<Vec<_>>()})
    };
    Ok(
        json!({"encounter":data.encounter_order.iter().map(record).collect::<Vec<_>>(),"sorted":data.keys().map(record).collect::<Vec<_>>() }),
    )
}
fn sos_filter(samples: &[f32], key: &str) -> Vec<f32> {
    let config: Value = serde_json::from_str(include_str!("filter-coefficients.json")).unwrap();
    let sections: Vec<Vec<f64>> = config[key]
        .as_array()
        .unwrap()
        .iter()
        .map(gate::vector)
        .collect();
    let mut values: Vec<_> = samples.iter().map(|x| *x as f64).collect();
    for c in sections {
        let (mut z0, mut z1) = (0., 0.);
        for x in &mut values {
            let y = c[0] * *x + z0;
            z0 = c[1] * *x - c[4] * y + z1;
            z1 = c[2] * *x - c[5] * y;
            *x = y;
        }
    }
    values.into_iter().map(|x| x as f32).collect()
}
fn level(samples: &[f32], db: f64) -> Vec<f32> {
    let rms = (gate::sum_squares32(samples) / samples.len().max(1) as f32).sqrt() + 1e-9f32;
    let multiplier = 10f64.powf(db / 20.) as f32;
    samples.iter().map(|x| (*x * multiplier) / rms).collect()
}
fn noise(count: usize, rng: &mut Rng) -> Vec<f32> {
    let white: Vec<_> = (0..count).map(|_| rng.normal() as f32).collect();
    sos_filter(&white, "noise")
}
fn near(samples: &[f32], rng: &mut Rng) -> Vec<f32> {
    let band = level(&sos_filter(samples, "near"), -26.);
    let bed = level(&noise(samples.len(), rng), -51.);
    band.iter().zip(bed).map(|(a, b)| a + b).collect()
}
fn far(samples: &[f32], rng: &mut Rng) -> Result<Vec<f32>> {
    let tail = 8000;
    let mut room: Vec<_> = (0..tail)
        .map(|i| rng.normal() * (-6.9 * i as f64 / tail as f64).exp())
        .collect();
    room[0] = 4.;
    unsafe extern "C" {
        fn herdr_fftconvolve_f32_f64(
            samples: *const f32,
            count: usize,
            room: *const f64,
            tail: usize,
            output: *mut f32,
        ) -> i32;
    }
    let mut wet = vec![0.; samples.len()];
    let status = unsafe {
        herdr_fftconvolve_f32_f64(
            samples.as_ptr(),
            samples.len(),
            room.as_ptr(),
            room.len(),
            wet.as_mut_ptr(),
        )
    };
    if status != 0 {
        return Err("native PocketFFT convolution failed".into());
    }
    let wet = level(&wet, -46.);
    let bed = level(&noise(samples.len(), rng), -51.);
    Ok(wet.iter().zip(bed).map(|(a, b)| a + b).collect())
}
pub fn dsp_probe(input: &Value) -> Result<Value> {
    let samples: Vec<_> = gate::vector(&input["samples"])
        .into_iter()
        .map(|n| n as f32)
        .collect();
    let mut rng = Rng::new(input["seed"].as_u64().unwrap_or(7));
    let result = match input["op"].as_str().unwrap_or("") {
        "near" => near(&samples, &mut rng),
        "far" => far(&samples, &mut rng)?,
        "noise" => noise(
            input["count"].as_u64().ok_or("DSP count missing")? as usize,
            &mut rng,
        ),
        "level" => level(&samples, input["db"].as_f64().ok_or("DSP db missing")?),
        _ => return Err("unknown DSP probe".into()),
    };
    Ok(json!(result))
}
fn extracted_segments(
    engine: &native::Engine,
    samples: &[f32],
    gain: f64,
    flush: bool,
    strict_blocks: bool,
) -> Result<Vec<Vec<f32>>> {
    engine.reset()?;
    let mut result = vec![];
    for (i, block) in samples.chunks(512).enumerate() {
        if strict_blocks && i * 512 + 512 >= samples.len() {
            break;
        }
        engine.accept(&block.iter().map(|n| *n * gain as f32).collect::<Vec<_>>())?;
        while let Some(s) = engine.take()? {
            result.push(s.into_iter().map(|n| n / gain as f32).collect());
        }
    }
    if flush {
        engine.flush()?;
        while let Some(s) = engine.take()? {
            result.push(s.into_iter().map(|n| n / gain as f32).collect());
        }
    }
    Ok(result)
}
fn wav(path: &Path) -> Result<Vec<f32>> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    if spec.sample_rate != 16000
        || spec.channels != 1
        || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
    {
        return Err(format!("unexpected format: {}", path.display()).into());
    }
    Ok(reader
        .samples::<i16>()
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .map(|x| x as f32 / 32768.)
        .collect())
}
fn clip(name: &str) -> Result<Vec<f32>> {
    let cache = settings::voice_home().join("crosscheck");
    fs::create_dir_all(&cache)?;
    let path = cache.join(format!("{}.wav", name.replace('/', "_")));
    if !path.exists() {
        let part = path.with_extension("wav.part");
        let mut response = crate::tls::blocking_builder()?
            .build()?
            .get(format!(
                "https://raw.githubusercontent.com/csukuangfj/sr-data/main/{name}.wav"
            ))
            .send()?
            .error_for_status()?;
        // urlretrieve writes the .part file before replacing the cached clip.
        let mut file = fs::File::create(&part)?;
        std::io::copy(&mut response, &mut file)?;
        fs::rename(part, &path)?;
    }
    wav(&path)
}
pub fn crosscheck() -> Result<()> {
    let own_pool = settings::state_dir().join("voice-pool.jsonl");
    if !own_pool.exists() {
        return Err(
            "no voice learned on this Mac yet: send some dictations first (or ./focusq voice-enroll)"
                .into(),
        );
    }
    let mut mine: Vec<_> = policy::segments(&own_pool, usize::MAX)
        .iter()
        .map(|i| gate::vector(&i["vector"]))
        .collect();
    for v in &mut mine {
        gate::normalize(v)?;
    }
    let engine = gate::engine(None)?;
    let speakers: [(&str, &[&str], &[&str]); 5] = [
        (
            "fangjun",
            &[
                "enroll/fangjun-sr-1",
                "enroll/fangjun-sr-2",
                "enroll/fangjun-sr-3",
            ],
            &["test/fangjun-test-sr-1", "test/fangjun-test-sr-2"],
        ),
        (
            "leijun",
            &["enroll/leijun-sr-1", "enroll/leijun-sr-2"],
            &[
                "test/leijun-test-sr-1",
                "test/leijun-test-sr-2",
                "test/leijun-test-sr-3",
            ],
        ),
        (
            "liudehua",
            &["enroll/liudehua-sr-1", "enroll/liudehua-sr-2"],
            &["test/liudehua-test-sr-1", "test/liudehua-test-sr-2"],
        ),
        (
            "speaker1",
            &[
                "test/3d-speaker/speaker1_a_cn_16k",
                "test/3d-speaker/speaker1_a_en_16k",
            ],
            &[
                "test/3d-speaker/speaker1_b_cn_16k",
                "test/3d-speaker/speaker1_b_en_16k",
            ],
        ),
        (
            "speaker2",
            &["test/3d-speaker/speaker2_a_cn_16k"],
            &["test/3d-speaker/speaker2_a_en_16k"],
        ),
    ];
    crate::legacy_text::print_line(&format!(
        "내 목소리 구간 {}개를 다른 사람 기기 {}대에서 판정합니다.\n",
        mine.len(),
        speakers.len()
    ))?;
    crate::legacy_text::print_line(&format!(
        "{:<14} {:>5} {:>5} {:>9} {:>11} {:>8}",
        "다른 사람 기기", "학습", "기준", "그 사람 통과", "내 목소리 통과", "내 최고점"
    ))?;
    let mut leaked = 0;
    let cfg = settings::load();
    let threshold = cfg["default_threshold"].as_f64().unwrap_or(0.4);
    for (name, learn, check) in speakers {
        let mut learned = vec![];
        let mut held = vec![];
        for (paths, result) in [(learn, &mut learned), (check, &mut held)] {
            for path in paths {
                for s in extracted_segments(&engine, &clip(path)?, 1., true, false)? {
                    if s.len() >= RATE {
                        result.push((s.len() as f64 / RATE as f64, engine.embed(&s)?));
                    }
                }
            }
        }
        let vectors: Vec<_> = learned.iter().map(|(_, v)| v.clone()).collect();
        let weights: Vec<_> = learned.iter().map(|(d, _)| *d).collect();
        let print = gate::build(&vectors, &weights, threshold)?;
        let scores: Vec<_> = mine.iter().map(|v| gate::dot(v, &print)).collect();
        let theirs = held
            .iter()
            .filter(|(_, v)| gate::dot(v, &print) >= threshold)
            .count();
        let passed = scores.iter().filter(|s| **s >= threshold).count();
        leaked += passed;
        crate::legacy_text::print_line(&format!(
            "{name:14} {:4.0}s {threshold:5.2} {theirs:5}/{:<3} {passed:7}/{:<3} {:8.2}",
            weights.iter().sum::<f64>(),
            held.len(),
            mine.len(),
            scores.iter().copied().fold(f64::NEG_INFINITY, f64::max)
        ))?;
    }
    crate::legacy_text::print_line(&format!(
        "\n내 목소리가 다른 사람 기기에서 본인으로 통과한 구간: {leaked}개"
    ))?;
    if leaked > 0 {
        Err(Exit(1).into())
    } else {
        Ok(())
    }
}
fn log_events(day: chrono::NaiveDate, state: &Path) -> Result<Vec<(f64, String)>> {
    use chrono::TimeZone;
    let text = crate::legacy_text::read(
        state.join("focus-queue.log"),
        crate::legacy_text::ErrorPolicy::Ignore,
    )?;
    let regex = regex::Regex::new(r"^(\d\d):(\d\d):(\d\d\.\d+) (.*)")?;
    let mut previous = String::new();
    let mut events = vec![];
    for line in text.lines() {
        if let Some(c) = regex.captures(line) {
            if line[..8] < *previous.get(..8).unwrap_or("") {
                events.clear();
            }
            previous = line.to_owned();
            let base = day
                .and_hms_opt(c[1].parse()?, c[2].parse()?, 0)
                .ok_or("invalid log clock")?;
            let stamp = chrono::Local
                .from_local_datetime(&base)
                .earliest()
                .ok_or("ambiguous local clock")?
                .timestamp() as f64
                + c[3].parse::<f64>()?;
            events.push((stamp, c[4].to_owned()));
        }
    }
    Ok(events)
}
pub fn replay(args: &[String]) -> Result<()> {
    use chrono::TimeZone;
    let parsed = super::cli::parse(args, &["--panes", "--other", "--typed"], &[])?;
    if parsed.help {
        crate::help::show("replay_voice_policy", &["--help".into()])?;
        return Ok(());
    }
    let args = &parsed.normalized;
    let Some(panes_text) = super::cli::value(args, "--panes", &["--panes", "--other", "--typed"])
    else {
        return crate::common::usage("the following arguments are required: --panes");
    };
    super::cli::unknown(&parsed.unknown)?;
    let mut panes = BTreeMap::new();
    for item in panes_text.split(',') {
        let parts = item.split('=').collect::<Vec<_>>();
        if parts.len() != 2 {
            return Err("invalid session prefix=pane mapping".into());
        }
        panes.insert(parts[0], parts[1]);
    }
    let other =
        super::cli::value(args, "--other", &["--panes", "--other", "--typed"]).unwrap_or("");
    let typed =
        super::cli::value(args, "--typed", &["--panes", "--other", "--typed"]).unwrap_or("");
    // This diagnostic intentionally uses the fixed personal replay directory,
    // unlike the live plugin's HERDR_PLUGIN_STATE_DIR override.
    let state = settings::home().join(".local/state/herdr/plugins/local.focus-queue");
    let segments = policy::segments(&state.join("voice-segments.jsonl"), 1000);
    let since = segments
        .iter()
        .find(|s| !s["score"].is_null())
        .and_then(|s| s["end"].as_f64())
        .ok_or("no scored segments")?;
    let until = segments
        .last()
        .and_then(|s| s["end"].as_f64())
        .ok_or("no voice segments")?;
    let day = chrono::Local
        .timestamp_opt(since as i64, 0)
        .single()
        .ok_or("invalid segment timestamp")?
        .date_naive();
    let events = log_events(day, &state)?;
    let mut messages = vec![];
    let projects = settings::home().join(".claude/projects");
    let paths = fs::read_dir(projects)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .flat_map(|entry| glob_files(&entry.path(), "jsonl"))
        .collect::<Vec<_>>();
    for path in paths {
        if super::mtime(&path).unwrap_or(0.) < since {
            continue;
        }
        let text = crate::legacy_text::read(&path, crate::legacy_text::ErrorPolicy::Ignore)?;
        for line in text.lines() {
            if !line.contains("\"type\":\"user\"") {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if v["type"] != "user"
                || crate::observers::truth(&v["isMeta"])
                || crate::observers::truth(&v["isSidechain"])
            {
                continue;
            }
            let content = &v["message"]["content"];
            let text = content.as_str().map(str::to_owned).unwrap_or_else(|| {
                content
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|p| p["type"] == "text")
                    .map(|p| p["text"].as_str().unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join(" ")
            });
            let text = crate::python_unicode::trim(&text).to_owned();
            let stamp = super::iso::timestamp(
                v["timestamp"]
                    .as_str()
                    .ok_or("missing transcript timestamp")?,
            )?;
            if !text.is_empty()
                && !text.starts_with('<')
                && !text.contains("<hc from=")
                && stamp >= since
                && stamp <= until
            {
                messages.push((
                    stamp,
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .chars()
                        .take(6)
                        .collect::<String>(),
                    text,
                ));
            }
        }
    }
    messages.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let cfg = settings::load();
    let short = cfg["short_score"].as_f64().unwrap_or(0.5);
    let mut tally = Vec::<((String, bool), usize)>::new();
    for (when, session, text) in messages {
        let Some(pane) = panes.get(session.as_str()) else {
            continue;
        };
        if pane.is_empty() {
            continue;
        }
        let clock = chrono::Local
            .timestamp_opt(when as i64, 0)
            .single()
            .ok_or("invalid message timestamp")?
            .format("%H:%M:%S")
            .to_string();
        if typed.contains(&clock) {
            continue;
        }
        let pattern = regex::Regex::new(&format!(r"voice (on|re-armed) {}$", pane))?;
        let Some((armed, _)) = events
            .iter()
            .filter(|(at, line)| *at < when - 0.4 && pattern.is_match(line))
            .last()
        else {
            continue;
        };
        let (mine, others) = policy::heard(&segments, armed - 1., when + 1., short);
        let count = text.chars().count();
        let passed = policy::own_dictation(&segments, armed - 1., when + 1., count, &cfg);
        let kind = if other.contains(&clock) {
            "other"
        } else {
            "own"
        };
        if let Some((_, count)) = tally
            .iter_mut()
            .find(|(key, _)| key.0 == kind && key.1 == passed)
        {
            *count += 1;
        } else {
            tally.push(((kind.into(), passed), 1));
        }
        let ratio = if mine > 0. {
            format!("{:.1}", count as f64 / mine)
        } else {
            "-".into()
        };
        let score = policy::mean_score(&segments, armed - 1., when + 1., short);
        crate::legacy_text::print_line(&format!("{clock} {pane} {kind} {count}자 본인 {mine:.1}s 타인 {others:.1}s 자/초 {ratio} 평균 {score:.2} {} {}",if passed{"통과"}else{"차단"},if passed==(kind=="own"){String::new()}else{format!("  <== 어긋남: {}",text.chars().take(30).collect::<String>())}))?;
    }
    crate::legacy_text::print_line(&format!(
        "{{{}}}",
        tally
            .iter()
            .map(|((kind, passed), count)| format!(
                "('{kind}', {}): {count}",
                if *passed { "True" } else { "False" }
            ))
            .collect::<Vec<_>>()
            .join(", ")
    ))?;
    Ok(())
}
fn heard(engine: &native::Engine, samples: &[f32], boost: f64) -> Result<f64> {
    let gain = 10f64.powf(boost / 20.);
    Ok(extracted_segments(engine, samples, gain, true, true)?
        .iter()
        .map(Vec::len)
        .sum::<usize>() as f64
        / RATE as f64)
}
pub fn vad(args: &[String]) -> Result<()> {
    let data = load(Path::new(arg(args, 0)?))?;
    let model = Path::new(arg(args, 1)?);
    let out = Path::new(arg(args, 2)?);
    let mut rng = Rng::new(3);
    let clips: Vec<_> = data.values().flat_map(|c| c.iter().take(4)).collect();
    let clips: Vec<_> = rng
        .permutation(clips.len())
        .into_iter()
        .take(60)
        .map(|i| clips[i])
        .collect();
    let mut results = vec![];
    for floor in [-65, -51] {
        let bed = level(&noise(60 * RATE, &mut rng), floor as f64);
        for (threshold, boost) in [(0.5, 0.), (0.35, 0.), (0.2, 0.), (0.5, 20.), (0.35, 20.)] {
            let engine = native::Engine::vad_only(model, threshold)?;
            let mut row = json!({"noise_floor_db":floor,"threshold":threshold,"boost_db":boost as i32,"false_seconds_per_minute":round(heard(&engine,&bed,boost)?,1),"recall":{}});
            for db in [-26, -36, -46, -52, -58, -64] {
                let (mut found, mut whole, mut missed) = (0., 0., 0);
                for clip in &clips {
                    let mut mixed = level(clip, db as f64);
                    mixed.resize(mixed.len() + RATE, 0.);
                    if mixed.len() > bed.len() {
                        return Err("clip exceeds evaluation noise bed".into());
                    }
                    for (m, b) in mixed.iter_mut().zip(&bed) {
                        *m += b;
                    }
                    let seconds = heard(&engine, &mixed, boost)?;
                    let duration = clip.len() as f64 / RATE as f64;
                    found += seconds.min(duration);
                    whole += duration;
                    if seconds == 0. {
                        missed += 1;
                    }
                }
                row["recall"][db.to_string()] = json!([round(found / whole, 3), missed]);
            }
            crate::legacy_text::print_line(&vad_stdout(&row))?;
            results.push(row);
        }
    }
    evaluation_write(out, &json!({"clips":clips.len(),"rows":results}))
}
fn eer(target: &[f64], other: &[f64]) -> f64 {
    let mut scores: Vec<_> = target.iter().chain(other).copied().collect();
    scores.sort_by(f64::total_cmp);
    let mut best = (f64::INFINITY, 0.);
    for score in scores {
        let miss = target.iter().filter(|s| **s < score).count() as f64 / target.len() as f64;
        let alarm = 1. - other.iter().filter(|s| **s < score).count() as f64 / other.len() as f64;
        let delta = (miss - alarm).abs();
        if delta < best.0 {
            best = (delta, (miss + alarm) / 2.);
        }
    }
    best.1
}
fn peak_rss() -> f64 {
    #[cfg(unix)]
    {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0 {
            return unsafe { usage.assume_init() }.ru_maxrss as f64 / 1e6;
        }
    }
    0.
}
fn run_model(data_dir: &Path, model: &Path) -> Result<Value> {
    let data = load(data_dir)?;
    let engine = native::Engine::embedding_only(model)?;
    let base = peak_rss();
    let mut rng = Rng::new(7);
    let lengths = [1., 1.5, 2., 3.];
    let mut prints = vec![];
    let mut tests: Vec<(Vec<Vec<f64>>, Vec<Vec<f64>>, Vec<usize>)> =
        vec![(vec![], vec![], vec![]); 4];
    for (owner, clips) in data.sorted_values().enumerate() {
        let (mut joined, mut enrolled, mut used) = (vec![], 0, 0);
        for (index, clip) in clips.iter().enumerate() {
            used = index;
            if enrolled >= 45 * RATE {
                break;
            }
            joined.push(engine.embed(&near(clip, &mut rng))?);
            enrolled += clip.len();
        }
        let mut centre = super::linalg::mean(&joined)?;
        gate::normalize(&mut centre)?;
        prints.push(centre);
        let rest: Vec<_> = clips[used..].iter().flatten().copied().collect();
        for (index, length) in lengths.iter().enumerate() {
            let size = (length * RATE as f64) as usize;
            if rest.len() <= size {
                return Err("not enough test speech".into());
            }
            let starts: Vec<_> = (0..8).map(|_| rng.integer(rest.len() - size)).collect();
            for start in starts {
                let piece = &rest[start..start + size];
                tests[index].0.push(engine.embed(&near(piece, &mut rng))?);
                tests[index].1.push(engine.embed(&far(piece, &mut rng)?)?);
                tests[index].2.push(owner);
            }
        }
    }
    let mut result = json!({"model":model.file_name().unwrap_or_default().to_string_lossy(),"megabytes":fs::metadata(model)?.len()as f64/1e6,"speakers":prints.len(),"by_length":{}});
    for (index, (near, far, owners)) in tests.iter().enumerate() {
        let (mut target, mut other_near, mut other_far) = (vec![], vec![], vec![]);
        let near_scores = super::linalg::gram(near, &prints);
        let far_scores = super::linalg::gram(far, &prints);
        for ((n, f), owner) in near_scores.iter().zip(&far_scores).zip(owners) {
            for index in 0..prints.len() {
                if index == *owner {
                    target.push(n[index]);
                } else {
                    other_near.push(n[index]);
                    other_far.push(f[index]);
                }
            }
        }
        if target.is_empty() || other_far.is_empty() {
            return Err("model evaluation requires multiple speakers".into());
        }
        let threshold = gate::percentile(&other_far, 0.999);
        let miss = target.iter().filter(|x| **x < threshold).count() as f64 / target.len() as f64;
        result["by_length"][format!("{:.1}", lengths[index])] = json!({"eer_near":eer(&target,&other_near),"eer_far":eer(&target,&other_far),"miss_at_far_0.1pct":miss,"target_p5":gate::percentile(&target,0.05),"target_median":gate::median(&target),"far_other_p99":gate::percentile(&other_far,0.99),"far_other_max":other_far.iter().copied().fold(f64::NEG_INFINITY,f64::max),"trials":[target.len(),other_far.len()]});
    }
    let sample: Vec<_> = data
        .values()
        .next()
        .ok_or("empty dataset")?
        .iter()
        .flatten()
        .take(3 * RATE)
        .copied()
        .collect();
    engine.embed(&sample)?;
    let started = Instant::now();
    for _ in 0..20 {
        engine.embed(&sample)?;
    }
    result["ms_per_3s"] = json!(started.elapsed().as_secs_f64() * 50.);
    result["peak_rss_mb"] = json!(peak_rss());
    result["after_load_rss_mb"] = json!(base);
    Ok(result)
}
pub fn models(args: &[String]) -> Result<()> {
    if args.first().map(String::as_str) == Some("--one") {
        crate::legacy_text::print_line(&evaluation_compact(&run_model(
            Path::new(arg(args, 1)?),
            Path::new(arg(args, 2)?),
        )?))?;
        return Ok(());
    }
    let data = arg(args, 0)?;
    let model_dir = Path::new(arg(args, 1)?);
    let out = Path::new(arg(args, 2)?);
    let paths = glob_files(model_dir, "onnx")
        .into_iter()
        .filter(|path| !path.to_string_lossy().contains("silero"))
        .collect::<Vec<_>>();
    let mut results = vec![];
    for path in paths {
        let exe = std::env::current_exe()?;
        let result = super::capture(
            &exe.to_string_lossy(),
            &["voice_eval_models", "--one", data, &path.to_string_lossy()],
            None,
        )?;
        if result.code == 0 {
            let stdout = result.stdout;
            let value: Value =
                serde_json::from_str(stdout.lines().last().ok_or("empty model report")?)?;
            let far: serde_json::Map<String, Value> = value["by_length"]
                .as_object()
                .ok_or("model report lacks by_length")?
                .iter()
                .map(|(length, metrics)| {
                    (
                        length.clone(),
                        json!(round(metrics["eer_far"].as_f64().unwrap_or(0.), 4)),
                    )
                })
                .collect();
            crate::legacy_text::print_line(&format!(
                "{} {} {} ms {} MB",
                value["model"].as_str().unwrap_or(""),
                crate::automation::format::repr(&Value::Object(far)),
                value["ms_per_3s"].as_f64().unwrap_or(0.).round_ties_even() as i64,
                value["peak_rss_mb"]
                    .as_f64()
                    .unwrap_or(0.)
                    .round_ties_even() as i64,
            ))?;
            results.push(value);
            evaluation_write(out, &json!(results))?;
        } else {
            let text = result.stderr;
            evaluation_stderr(&format!(
                "{} {}",
                path.display(),
                text.chars()
                    .rev()
                    .take(400)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            ))?;
        }
    }
    Ok(())
}
pub fn chain(args: &[String]) -> Result<()> {
    let data = load(Path::new(arg(args, 0)?))?;
    let models = Path::new(arg(args, 1)?);
    if data.len() < 8 {
        return Err("gate-chain evaluation requires at least eight speakers".into());
    }
    let cfg = settings::load();
    for (name, threshold, gain) in [
        ("기존 (VAD 0.5, 이득 없음)".to_owned(), 0.5, 1.),
        (
            format!(
                "변경 (VAD {}, 이득 {}배)",
                cfg["vad_threshold"].as_f64().unwrap_or(0.35),
                cfg["vad_gain"].as_f64().unwrap_or(10.)
            ),
            cfg["vad_threshold"].as_f64().unwrap_or(0.35),
            cfg["vad_gain"].as_f64().unwrap_or(10.),
        ),
    ] {
        let engine = native::Engine::load(
            &models.join(gate::EMBEDDING_MODEL),
            &models.join("silero_vad.onnx"),
            threshold,
        )?;
        let mut rng = Rng::new(11);
        let names: Vec<_> = data.keys().collect();
        let mut rows = serde_json::Map::<String, Value>::new();
        for trial in 0..8 {
            let user = names[trial];
            let clips = &data[user];
            let (mut enrolled, mut total) = (vec![], 0);
            for clip in clips {
                if total >= 45 * RATE {
                    break;
                }
                enrolled.push(clip);
                total += clip.len();
            }
            let prints = enrolled
                .iter()
                .map(|s| engine.embed(&near(s, &mut rng)))
                .collect::<Result<Vec<_>>>()?;
            let mut print = super::linalg::mean(&prints)?;
            gate::normalize(&mut print)?;
            let others: Vec<_> = names.iter().filter(|n| **n != user).collect();
            let mut scenes = vec![];
            for i in 0..6 {
                scenes.push((
                    "본인 -26".to_owned(),
                    clips
                        .get(enrolled.len() + i)
                        .ok_or("insufficient held-out clips")?,
                    -26,
                ));
            }
            for db in [-36, -46, -52] {
                for i in 0..6 {
                    scenes.push((
                        format!("타인 {db}"),
                        data[*others[i]]
                            .get(i)
                            .ok_or("insufficient other-speaker clips")?,
                        db,
                    ));
                }
            }
            for (label, clip, db) in scenes {
                let mut mixed = if db == -26 {
                    near(clip, &mut rng)
                } else {
                    let speech = level(clip, db as f64);
                    let bed = level(&noise(clip.len(), &mut rng), -51.);
                    speech.iter().zip(bed).map(|(a, b)| a + b).collect()
                };
                mixed.resize(mixed.len() + RATE, 0.);
                let mut clock = 100.;
                let mut segments = vec![];
                for piece in extracted_segments(&engine, &mixed, gain, false, true)? {
                    let seconds = piece.len() as f64 / RATE as f64;
                    let score = gate::dot(&engine.embed(&piece)?, &print);
                    let me = if seconds < 1. {
                        None
                    } else {
                        Some(score >= cfg["default_threshold"].as_f64().unwrap_or(0.4))
                    };
                    segments.push(json!({"start":clock,"end":clock+seconds,"seconds":seconds,"score":score,"me":me}));
                    clock += seconds;
                }
                let chars = (clip.len() as f64 / RATE as f64 * 7.) as usize;
                let row=rows.entry(label).or_insert_with(||json!({"total":0,"unheard":0,"judged_me":0,"passed":0,"heard":0.,"whole":0.,"scores":[]}));
                let score = round(
                    policy::mean_score(
                        &segments,
                        0.,
                        1e9,
                        cfg["short_score"].as_f64().unwrap_or(0.5),
                    ),
                    2,
                );
                row["scores"].as_array_mut().unwrap().push(json!(score));
                for (key, add) in [
                    ("total", 1),
                    ("unheard", segments.is_empty() as u64),
                    ("judged_me", segments.iter().any(|s| s["me"] == true) as u64),
                    (
                        "passed",
                        policy::own_dictation(&segments, 0., 1e9, chars, &cfg) as u64,
                    ),
                ] {
                    row[key] = json!(row[key].as_u64().unwrap_or(0) + add);
                }
                row["heard"] = json!(
                    row["heard"].as_f64().unwrap_or(0.)
                        + segments
                            .iter()
                            .map(|s| s["seconds"].as_f64().unwrap_or(0.))
                            .sum::<f64>()
                );
                row["whole"] =
                    json!(row["whole"].as_f64().unwrap_or(0.) + clip.len() as f64 / RATE as f64);
            }
        }
        crate::legacy_text::print_line(&name)?;
        for (label, row) in rows {
            let scores = gate::vector(&row["scores"]);
            let low = scores
                .iter()
                .copied()
                .filter(|s| *s != 0.)
                .reduce(f64::min)
                .unwrap_or(0.);
            let high = scores.iter().copied().reduce(f64::max).unwrap_or(0.);
            crate::legacy_text::print_line(&format!("  {label}: {}건 / 구간 없음 {} / 본인 판정 구간 있음 {} / 전송 규칙 통과 {} / 들린 비율 {:.2} / 평균 점수 범위 {low:.2}~{high:.2}",row["total"],row["unheard"],row["judged_me"],row["passed"],row["heard"].as_f64().unwrap_or(0.)/row["whole"].as_f64().unwrap_or(1.)))?;
        }
    }
    Ok(())
}
pub fn check_settings(args: &[String]) -> Result<()> {
    let titles = [
        "tap 정상",
        "/voice 끔→켬, 안내문 보임",
        "/voice 끔→켬, 안내문 스크롤됨, 바로",
        "/voice 끔→켬, 60초 뒤",
        "켜진 채 일시 미반응 2회, 60초 뒤",
        "잠긴 뒤 수동 F8, 포커스 복귀",
        "잠긴 뒤 세션 재시작",
        "hold 설정",
        "hold 로 바꾸고 60초 뒤",
    ];
    let files = if args.is_empty() {
        vec![None]
    } else {
        args.iter().map(|s| Some(s.as_str())).collect::<Vec<_>>()
    };
    crate::legacy_text::print_line(&format!(
        "| 조합 | {} |",
        files
            .iter()
            .flat_map(|p| ["일반", "브리지", "앱"].map(move |k| {
                let label = p
                    .and_then(|p| {
                        Path::new(p)
                            .parent()
                            .and_then(Path::file_name)
                            .and_then(|s| s.to_str())
                    })
                    .filter(|s| !s.is_empty())
                    .unwrap_or(p.unwrap_or("voice"));
                format!("{label} {k}")
            }))
            .collect::<Vec<_>>()
            .join(" | ")
    ))?;
    crate::legacy_text::print_line(&format!("|---|{}", "---|".repeat(3 * files.len())))?;
    for (scene, title) in titles.iter().enumerate() {
        let mut cells = vec![];
        for binary in &files {
            for kind in 0..3 {
                let recording = if let Some(binary) = binary {
                    let response = super::output_unbounded(
                        binary,
                        &[
                            "voice_probe",
                            "settings-scene",
                            &scene.to_string(),
                            &kind.to_string(),
                            "current-input",
                        ],
                        0.,
                    )?;
                    serde_json::from_str::<bool>(response.trim())?
                } else {
                    super::probe::settings_scene_current(scene, kind)?
                };
                cells.push(if recording { "REC" } else { "꺼짐" });
            }
        }
        crate::legacy_text::print_line(&format!("| {title} | {} |", cells.join(" | ")))?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_glob_case_and_hidden_file_classification() {
        let cases: Value = serde_json::from_str(include_str!("glob-fixtures.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                glob_extension(
                    Path::new(case["name"].as_str().unwrap()),
                    case["extension"].as_str().unwrap(),
                    case["windows"].as_bool().unwrap()
                ),
                case["expected"].as_bool().unwrap(),
                "{case}"
            );
        }
        let sandbox = tempfile::tempdir().unwrap();
        let missing = sandbox.path().join("missing");
        assert!(glob_files(&missing, "onnx").is_empty());
        fs::write(&missing, b"not a directory").unwrap();
        assert!(glob_files(&missing, "onnx").is_empty());
    }
    #[test]
    fn original_evaluation_json_bytes_use_one_space_ascii_and_no_final_newline() {
        let cases: Value =
            serde_json::from_str(include_str!("evaluation-json-fixtures.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                evaluation_json(&case["value"], 0),
                case["text"].as_str().unwrap()
            );
            let sandbox = tempfile::tempdir().unwrap();
            let path = sandbox.path().join("out.json");
            evaluation_write(&path, &case["value"]).unwrap();
            let expected = case["text"].as_str().unwrap();
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                if cfg!(windows) {
                    expected.replace('\n', "\r\n")
                } else {
                    expected.to_owned()
                }
            );
        }
    }
    #[test]
    fn original_python_decimal_rounding_preserves_binary_side_of_ties() {
        let cases: Value = serde_json::from_str(include_str!("round-fixtures.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let value = case["value"].as_f64().unwrap();
            let digits = case["digits"].as_i64().unwrap() as i32;
            let expected = case["expected"].as_f64().unwrap();
            let actual = round(value, digits);
            assert_eq!(
                actual.to_bits(),
                expected.to_bits(),
                "{value} round {digits}"
            );
        }
    }
    #[test]
    fn original_vad_uses_encounter_order_but_model_trials_sort_speakers() {
        let mut data = Dataset::new();
        for speaker in [3, 1, 7, 0, 6, 2, 5, 4, 3] {
            data.entry(Speaker::Number(speaker))
                .push(vec![speaker as f32]);
        }
        assert_eq!(
            data.values()
                .map(|clips| clips[0][0] as i32)
                .collect::<Vec<_>>(),
            vec![3, 1, 7, 0, 6, 2, 5, 4]
        );
        assert_eq!(
            data.sorted_values()
                .map(|clips| clips[0][0] as i32)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4, 5, 6, 7]
        );
        assert_eq!(data[&Speaker::Number(3)].len(), 2);
    }
    #[test]
    fn original_evaluation_stdout_keeps_integer_recall_keys_and_insertion_order() {
        let fixtures: Value =
            serde_json::from_str(include_str!("evaluation-output-fixtures.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            assert_eq!(
                vad_stdout(&fixture["row"]),
                fixture["stdout"].as_str().unwrap()
            );
        }
    }
    #[test]
    fn original_numpy_scipy_dsp_corpus() {
        let fixtures: Value = serde_json::from_str(include_str!("dsp-fixtures.json")).unwrap();
        for case in fixtures.as_array().unwrap() {
            let samples: Vec<_> = gate::vector(&case["samples"])
                .into_iter()
                .map(|n| n as f32)
                .collect();
            let mut rng = Rng::new(case["seed"].as_u64().unwrap());
            let got = match case["op"].as_str().unwrap() {
                "level" => level(&samples, case["db"].as_f64().unwrap()),
                "noise" => noise(case["count"].as_u64().unwrap() as usize, &mut rng),
                "near" => near(&samples, &mut rng),
                "far" => far(&samples, &mut rng).unwrap(),
                _ => unreachable!(),
            };
            let expected = gate::vector(&case["expected"]);
            assert_eq!(got.len(), expected.len());
            let max = got
                .iter()
                .zip(expected)
                .map(|(a, b)| (*a as f64 - b).abs())
                .fold(0f64, f64::max);
            assert!(
                max <= 1e-7,
                "{} max absolute float32 error {max}",
                case["op"]
            );
        }
    }
    #[test]
    fn error_rates_use_numpy_left_search_and_linear_quantile() {
        assert_eq!(eer(&[0.8, 0.9], &[0.1, 0.2]), 0.);
        assert_eq!(gate::percentile(&[0., 10.], 0.05), 0.5);
    }
    #[test]
    fn sos_rejects_dc_in_near_band() {
        let samples = vec![1.; 16000];
        let out = sos_filter(&samples, "near");
        assert!(out.iter().skip(8000).all(|v| v.abs() < 1e-6));
    }
}
