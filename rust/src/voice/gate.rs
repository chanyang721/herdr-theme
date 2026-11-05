use super::{append_json, mtime, native, now, policy, round, settings, write_json, Result};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    time::Instant,
};
pub const EMBEDDING_MODEL: &str = "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx";
pub fn dot(a: &[f64], b: &[f64]) -> f64 {
    super::linalg::dot(a, b)
}
pub fn judged(seconds: f64, score: f64, threshold: f64) -> Option<bool> {
    if seconds < 1. {
        None
    } else {
        Some(score >= threshold)
    }
}
pub fn normalize(v: &mut [f64]) -> Result<()> {
    let n = dot(v, v).sqrt();
    if !n.is_finite() || n == 0. {
        return Err("zero or non-finite voice embedding".into());
    }
    for x in v {
        *x /= n;
    }
    Ok(())
}
pub fn vector(value: &Value) -> Vec<f64> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_f64)
        .collect()
}
pub fn percentile(values: &[f64], q: f64) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    let mut x = values.to_vec();
    x.sort_by(f64::total_cmp);
    let pos = q * (x.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    x[lo] + (x[hi] - x[lo]) * (pos - lo as f64)
}
pub fn build(vectors: &[Vec<f64>], weights: &[f64], threshold: f64) -> Result<Vec<f64>> {
    if vectors.is_empty()
        || vectors.len() != weights.len()
        || vectors.iter().any(|v| v.len() != vectors[0].len())
    {
        return Err("invalid voiceprint training vectors".into());
    }
    let mut seed = 0;
    let mut count = 0;
    for (i, scores) in super::linalg::self_gram(vectors).iter().enumerate() {
        let n = scores.iter().filter(|s| **s >= threshold).count();
        if n > count {
            seed = i;
            count = n;
        }
    }
    let mut centre = vectors[seed].clone();
    for _ in 0..3 {
        let mut sum = vec![0.; centre.len()];
        let mut kept_weights = vec![];
        let scores = super::linalg::matvec(vectors, &centre);
        for ((v, w), score) in vectors.iter().zip(weights).zip(scores) {
            if score >= threshold {
                for (s, x) in sum.iter_mut().zip(v) {
                    *s += x * w;
                }
                kept_weights.push(*w);
            }
        }
        let total = super::linalg::sum(&kept_weights);
        if total == 0. {
            return Err("empty voiceprint cluster".into());
        }
        for x in &mut sum {
            *x /= total;
        }
        normalize(&mut sum)?;
        centre = sum;
    }
    Ok(centre)
}
pub fn adapted_threshold(held: &[f64], previous: &Value, cfg: &Value) -> f64 {
    if previous["threshold_pinned"] == true {
        return previous["threshold"].as_f64().unwrap_or(0.4);
    }
    let default = cfg["default_threshold"].as_f64().unwrap_or(0.4);
    if held.len() < 30 {
        return default;
    }
    round(
        (percentile(held, 0.05) - 0.05)
            .max(default)
            .min(cfg["max_threshold"].as_f64().unwrap_or(0.5)),
        3,
    )
}
#[derive(Clone)]
pub struct Files {
    pub dir: PathBuf,
    pub print: PathBuf,
    pub pool: PathBuf,
    pub device: String,
    pub gain: f64,
}
impl Files {
    pub fn for_device(name: &str) -> Result<Self> {
        let dir = settings::state_dir();
        fs::create_dir_all(&dir)?;
        let device = settings::device_key(name);
        let cfg = settings::load();
        let gain = cfg["devices"][&device]["vad_gain"]
            .as_f64()
            .filter(|v| *v > 0.)
            .unwrap_or(cfg["vad_gain"].as_f64().unwrap_or(10.));
        let print = dir.join(format!("voiceprint-{device}.json"));
        let pool = dir.join(format!("voice-pool-{device}.jsonl"));
        let active = dir.join("voiceprint.json");
        let legacy_pool = dir.join("voice-pool.jsonl");
        if let Ok(meta) = fs::symlink_metadata(&active) {
            if !meta.file_type().is_symlink() {
                fs::rename(&active, &print)?;
                if legacy_pool.exists() {
                    fs::rename(&legacy_pool, &pool)?;
                }
            }
        }
        if fs::symlink_metadata(&active).is_ok() {
            fs::remove_file(&active)?;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(print.file_name().ok_or("invalid voiceprint path")?, &active)?;
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(
            print.file_name().ok_or("invalid voiceprint path")?,
            &active,
        )?;
        Ok(Self {
            dir,
            print,
            pool,
            device,
            gain,
        })
    }
    pub fn load(&self) -> Option<(Vec<f64>, f64)> {
        let data = settings::read_file(&self.print);
        if !data["vector"].is_array() {
            return None;
        }
        Some((
            vector(&data["vector"]),
            settings::device_threshold(&self.device)
                .unwrap_or(data["threshold"].as_f64().unwrap_or(0.4)),
        ))
    }
    pub fn save(
        &self,
        centre: &[f64],
        vectors: &[Vec<f64>],
        seconds: f64,
        held: &[f64],
        cfg: &Value,
    ) -> Result<Vec<f64>> {
        let previous = settings::read_file(&self.print);
        let default = cfg["default_threshold"].as_f64().unwrap_or(0.4);
        let mut scores: Vec<_> = vectors
            .iter()
            .map(|v| dot(v, centre))
            .filter(|s| *s >= default)
            .collect();
        scores.sort_by(f64::total_cmp);
        write_json(
            &self.print,
            &json!({"vector":centre,"model":EMBEDDING_MODEL,"speech_seconds":round(seconds,1),"threshold":adapted_threshold(held,&previous,cfg),"held_out_scores":held.iter().map(|n|round(*n,3)).collect::<Vec<_>>(),"threshold_pinned":previous["threshold_pinned"]==true,"created":chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()}),
        )?;
        Ok(scores)
    }
}
pub struct Learner {
    recent: Vec<(f64, f64, f64, Vec<f64>)>,
    pub offset: u64,
    pub added: usize,
    pub held: Vec<f64>,
}
impl Learner {
    pub fn new(files: &Files) -> Self {
        Self {
            recent: vec![],
            offset: 0,
            added: 0,
            held: vector(&settings::read_file(&files.print)["held_out_scores"]),
        }
    }
    pub fn heard(&mut self, start: f64, end: f64, seconds: f64, vector: Vec<f64>) {
        if seconds >= 1. {
            self.recent.retain(|r| r.1 > end - 300.);
            self.recent.push((start, end, seconds, vector));
        }
    }
    pub fn confirm(
        &mut self,
        files: &Files,
        voiceprint: Option<&[f64]>,
        cfg: &Value,
    ) -> Result<bool> {
        let path = files.dir.join("voice-confirmed.jsonl");
        let Ok(mut f) = OpenOptions::new().read(true).open(&path) else {
            return Ok(false);
        };
        f.seek(SeekFrom::Start(self.offset))?;
        let mut text = String::new();
        f.read_to_string(&mut text)?;
        self.offset = f.stream_position()?;
        let spans = text
            .lines()
            .map(serde_json::from_str::<Value>)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let Some(voiceprint) = voiceprint else {
            self.recent.clear();
            return Ok(false);
        };
        for span in spans {
            let start = span["start"].as_f64().ok_or("invalid confirmed start")?;
            let end = span["end"].as_f64().ok_or("invalid confirmed end")?;
            for (a, b, seconds, v) in &self.recent {
                if *a < start - 1. || *b > end + 1. {
                    continue;
                }
                let score = dot(v, voiceprint);
                self.held.push(score);
                if self.held.len() > 200 {
                    self.held.remove(0);
                }
                if score >= cfg["pool_score"].as_f64().unwrap_or(0.5) {
                    append_json(
                        &files.pool,
                        &json!({"end":b,"seconds":seconds,"vector":v.iter().map(|n|round(*n,5)).collect::<Vec<_>>()}),
                    )?;
                    self.added += 1;
                }
            }
            self.recent.retain(|r| r.1 > end + 1.);
        }
        if self.added == 0 {
            return Ok(false);
        }
        let pool = policy::segments(&files.pool, usize::MAX);
        let (mut total, mut kept) = (0., vec![]);
        for item in pool.into_iter().rev() {
            if total >= 600. {
                break;
            }
            total += item["seconds"].as_f64().unwrap_or(0.);
            kept.push(item);
        }
        if total < 30. || self.added < 5 {
            return Ok(false);
        }
        let vectors: Vec<_> = kept.iter().map(|v| vector(&v["vector"])).collect();
        let weights: Vec<_> = kept
            .iter()
            .map(|v| v["seconds"].as_f64().unwrap_or(0.))
            .collect();
        let threshold = cfg["default_threshold"].as_f64().unwrap_or(0.4);
        let centre = build(&vectors, &weights, threshold)?;
        let mine: Vec<_> = kept
            .iter()
            .zip(&vectors)
            .filter(|(_, v)| dot(v, &centre) >= threshold)
            .collect();
        fs::write(&files.pool, "")?;
        for (item, _) in mine.iter().rev() {
            append_json(&files.pool, item)?;
        }
        files.save(
            &centre,
            &mine.iter().map(|(_, v)| (*v).clone()).collect::<Vec<_>>(),
            mine.iter()
                .map(|(i, _)| i["seconds"].as_f64().unwrap_or(0.))
                .sum(),
            &self.held,
            cfg,
        )?;
        self.added = 0;
        Ok(true)
    }
}
pub fn engine(model: Option<&str>) -> Result<native::Engine> {
    let models = settings::voice_home().join("models");
    native::Engine::load(
        &model
            .map(PathBuf::from)
            .unwrap_or_else(|| models.join(EMBEDDING_MODEL)),
        &models.join("silero_vad.onnx"),
        settings::load()["vad_threshold"].as_f64().unwrap_or(0.35),
    )
}
pub fn rms_db(samples: &[f32]) -> f64 {
    (20f32 * ((sum_squares32(samples) / samples.len().max(1) as f32).sqrt() + 1e-9f32).log10())
        as f64
}
/// NumPy's float32 pairwise reduction order; BSD-3-Clause attribution is in
/// licenses/numpy.txt. This avoids changing normalized experiment audio.
pub fn sum_squares32(samples: &[f32]) -> f32 {
    if samples.len() < 8 {
        return samples.iter().fold(-0f32, |a, x| a + *x * *x);
    }
    if samples.len() <= 128 {
        let mut r = [0f32; 8];
        for i in 0..8 {
            r[i] = samples[i] * samples[i];
        }
        let end = samples.len() - samples.len() % 8;
        for i in (8..end).step_by(8) {
            for j in 0..8 {
                r[j] += samples[i + j] * samples[i + j];
            }
        }
        let mut sum = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        for x in &samples[end..] {
            sum += *x * *x;
        }
        sum
    } else {
        let split = (samples.len() / 2) / 8 * 8;
        sum_squares32(&samples[..split]) + sum_squares32(&samples[split..])
    }
}
pub fn calibrate(name: &str, levels: &[f64], builtin: bool) -> Result<(f64, f64, bool)> {
    let speech_db = percentile(levels, 0.5);
    let gain = round(10f64.powf((-19. - speech_db) / 20.).clamp(1., 30.), 2);
    let key = settings::device_key(name);
    settings::update(|d| {
        if !d["devices"].is_object() {
            d["devices"] = json!({});
        }
        if !d["devices"][&key].is_object() {
            d["devices"][&key] = json!({});
        }
        d["devices"][&key]["speech_db"] = json!(round(speech_db, 1));
        d["devices"][&key]["vad_gain"] = json!(gain);
        if !d["auto_send_devices"].is_array() {
            d["auto_send_devices"] = json!([]);
        }
        if !builtin
            && !d["auto_send_devices"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .any(|s| name.to_lowercase().contains(&s.to_lowercase()))
        {
            d["auto_send_devices"]
                .as_array_mut()
                .unwrap()
                .push(json!(name));
        }
    })?;
    Ok((speech_db, gain, !builtin))
}
pub fn run(args: &[String]) -> Result<()> {
    let command = args.first().map(String::as_str).unwrap_or("");
    match command {
        "enroll" => enroll(args.get(1).map(|s| s.parse()).transpose()?.unwrap_or(45)),
        "serve" => serve(),
        "tail" => tail(),
        "default-input" => {
            println!("{}", native::Microphone::default_name()?);
            Ok(())
        }
        _ => Err(include_str!("help/voicegate.txt").trim_end().into()),
    }
}
fn feed(engine: &native::Engine, block: &[f32], gain: f64) -> Result<Vec<Vec<f32>>> {
    engine.accept(&block.iter().map(|x| *x * gain as f32).collect::<Vec<_>>())?;
    let mut found = vec![];
    while let Some(s) = engine.take()? {
        found.push(s.into_iter().map(|x| x / gain as f32).collect());
    }
    Ok(found)
}
fn enroll(seconds: u64) -> Result<()> {
    let mic = native::Microphone::open()?;
    let files = Files::for_device(&mic.name)?;
    let cfg = settings::load();
    let engine = engine(None)?;
    println!(
        "{seconds}초 동안 평소처럼 말해 주세요. 아래 문장을 읽어도 되고 아무 말이나 해도 됩니다.\n"
    );
    for s in [
        "로그인 화면에서 오류가 나는 원인을 찾아 줘.",
        "회신 문서에서 결제 부분을 다시 확인하고 정리해 줘.",
        "지금 포커스된 패널에서 녹음이 늦게 뜨는지 확인해 봐.",
        "테스트를 돌려 보고 실패한 항목만 알려 줘.",
        "견적서 질의사항을 항목별로 검토해서 정리해 줘.",
        "변경 사항을 커밋하고 결과를 알려 줘.",
        "팀에 보낼 메시지는 짧게 핵심만 정리해 줘.",
        "배포 전에 로컬 CI가 통과하는지 먼저 확인해.",
    ] {
        println!("  {s}");
    }
    println!("\n녹음 시작");
    let deadline = now() + seconds as f64;
    let mut speech = vec![];
    loop {
        for s in feed(&engine, &mic.block()?, files.gain)? {
            let duration = s.len() as f64 / 16000.;
            speech.push(s);
            println!(
                "  말 {duration:.1}초 (누적 {:.0}초)",
                speech.iter().map(Vec::len).sum::<usize>() as f64 / 16000.
            );
            if now() >= deadline {
                let total = speech.iter().map(Vec::len).sum::<usize>() as f64 / 16000.;
                if total < 15. {
                    return Err(format!(
                        "말소리가 {total:.0}초밖에 잡히지 않았습니다. 15초 이상 말해 주세요."
                    )
                    .into());
                }
                let judged: Vec<_> = speech.iter().filter(|s| s.len() >= 16000).collect();
                let vectors = judged
                    .iter()
                    .map(|s| engine.embed(s))
                    .collect::<Result<Vec<_>>>()?;
                let weights: Vec<_> = judged.iter().map(|s| s.len() as f64).collect();
                let centre = build(
                    &vectors,
                    &weights,
                    cfg["default_threshold"].as_f64().unwrap_or(0.4),
                )?;
                let scores = files.save(&centre, &vectors, total, &[], &cfg)?;
                fs::write(&files.pool, "")?;
                for (v, w) in vectors.iter().zip(weights) {
                    append_json(
                        &files.pool,
                        &json!({"end":now(),"seconds":w/16000.,"vector":v.iter().map(|n|round(*n,5)).collect::<Vec<_>>()}),
                    )?;
                }
                println!("\n저장: {}", files.print.display());
                if !scores.is_empty() {
                    println!("말소리 {total:.0}초, 구간 {}개, 본인 점수 최저 {:.2} / 중간 {:.2} (기준 {})",vectors.len(),scores[0],scores[scores.len()/2],cfg["default_threshold"]);
                }
                let (db, gain, headset) = calibrate(
                    &mic.name,
                    &speech.iter().map(|s| rms_db(s)).collect::<Vec<_>>(),
                    policy::builtin_input(),
                )?;
                println!(
                    "마이크 보정: 말소리 {db:.0} dBFS, 감지 증폭 {gain}배 → {}",
                    settings::path().display()
                );
                println!(
                    "{}",
                    if headset {
                        "이 마이크의 받아쓰기는 자동 전송합니다."
                    } else {
                        "내장 마이크는 주변 말까지 들어 자동 전송하지 않습니다. 쓰려면 위 파일의 auto_send_devices 에 이름을 넣으세요."
                    }
                );
                return Ok(());
            }
        }
    }
}
pub fn serve() -> Result<()> {
    let dir = settings::state_dir();
    fs::create_dir_all(&dir)?;
    if super::alive(&dir.join("voicegate.pid")) {
        return Ok(());
    }
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(dir.join("voicegate.lock"))?;
    if fs2::FileExt::try_lock_exclusive(&lock).is_err() {
        return Ok(());
    }
    let pid = dir.join("voicegate.pid");
    fs::write(&pid, std::process::id().to_string())?;
    let result = (|| -> Result<()> {
        let cfg = settings::load();
        let engine = engine(None)?;
        let mut written = 0;
        let mut loaded = PathBuf::new();
        let mut voiceprint = None;
        let mut threshold = 0.4;
        let mut learner = None::<Learner>;
        loop {
            let mic = native::Microphone::open()?;
            let files = Files::for_device(&mic.name)?;
            if loaded != files.print {
                loaded = files.print.clone();
                let (p, t) = files
                    .load()
                    .map(|(p, t)| (Some(p), t))
                    .unwrap_or((None, 0.4));
                voiceprint = p;
                threshold = t;
                let mut fresh = Learner::new(&files);
                fresh.offset = fs::metadata(dir.join("voice-confirmed.jsonl"))
                    .map(|m| m.len())
                    .unwrap_or(0);
                learner = Some(fresh);
            }
            let learner = learner.as_mut().unwrap();
            let mut checked = now();
            let mut silent = 0;
            let speaking = dir.join("voice-speaking");
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&speaking)?;
            loop {
                let block = match mic.block() {
                    Ok(b) => b,
                    Err(_) => break,
                };
                silent = if block.iter().any(|x| *x != 0.) {
                    0
                } else {
                    silent + 1
                };
                if silent as f64 * 512. / 16000. >= 5. {
                    break;
                }
                if now() - checked.max(mtime(&speaking).unwrap_or(0.)) >= 60. {
                    checked = now();
                    let exe = std::env::current_exe()?;
                    let fresh =
                        super::output(&exe.to_string_lossy(), &["voicegate", "default-input"], 5.)
                            .unwrap_or_default();
                    if fresh.trim() != mic.name {
                        break;
                    }
                }
                let found = feed(&engine, &block, files.gain)?;
                if engine.speaking()? {
                    filetime::set_file_mtime(&speaking, filetime::FileTime::now())?;
                }
                for samples in found {
                    let end = now();
                    let duration = samples.len() as f64 / 16000.;
                    let v = engine.embed(&samples)?;
                    learner.heard(end - duration, end, duration, v.clone());
                    if learner.confirm(&files, voiceprint.as_deref(), &cfg)? {
                        if let Some((p, t)) = files.load() {
                            voiceprint = Some(p);
                            threshold = t;
                        }
                    }
                    let score = voiceprint.as_ref().map(|p| dot(&v, p));
                    let me = score.and_then(|s| judged(duration, s, threshold));
                    append_json(
                        &dir.join("voice-segments.jsonl"),
                        &json!({"start":round(end-duration,3),"end":round(end,3),"seconds":round(duration,2),"score":score.map(|s|round(s,3)),"me":me,"db":round(rms_db(&samples),1)}),
                    )?;
                    written += 1;
                    if written % 200 == 0 {
                        let path = dir.join("voice-segments.jsonl");
                        let text = fs::read_to_string(&path)?;
                        let lines: Vec<_> = text.lines().collect();
                        fs::write(
                            path,
                            lines[lines.len().saturating_sub(200)..].join("\n") + "\n",
                        )?;
                    }
                }
            }
            drop(mic);
        }
    })();
    if fs::read_to_string(&pid).unwrap_or_default() == std::process::id().to_string() {
        let _ = fs::remove_file(pid);
    }
    result
}
fn tail() -> Result<()> {
    let mic = native::Microphone::open()?;
    let files = Files::for_device(&mic.name)?;
    let engine = engine(None)?;
    let (print, threshold) = files.load().ok_or("no voiceprint for this microphone")?;
    println!("기준 {threshold}. 말하면 구간마다 점수를 보여 줍니다 (Ctrl+C 종료)");
    loop {
        for s in feed(&engine, &mic.block()?, files.gain)? {
            let at = Instant::now();
            let duration = s.len() as f64 / 16000.;
            let score = dot(&engine.embed(&s)?, &print);
            let verdict = if duration < 1. {
                "판단 보류(짧음)"
            } else if score >= threshold {
                "본인"
            } else {
                "다른 사람"
            };
            println!(
                "{}  {duration:4.1}초  점수 {score:5.2}  {verdict}  (판정 {:.0}ms)",
                chrono::Local::now().format("%H:%M:%S"),
                at.elapsed().as_secs_f64() * 1000.
            );
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn isolated_files(dir: &std::path::Path, name: &str) -> Files {
        Files {
            dir: dir.to_path_buf(),
            print: dir.join(format!("voiceprint-{name}.json")),
            pool: dir.join(format!("voice-pool-{name}.jsonl")),
            device: name.into(),
            gain: 10.,
        }
    }
    fn confirmed(
        learner: &mut Learner,
        files: &Files,
        print: Option<&[f64]>,
        mut v: Vec<f64>,
    ) -> bool {
        normalize(&mut v).unwrap();
        learner.heard(100., 108., 8., v);
        append_json(
            &files.dir.join("voice-confirmed.jsonl"),
            &json!({"start":99.,"end":109.}),
        )
        .unwrap();
        learner
            .confirm(files, print, &settings::defaults())
            .unwrap()
    }
    #[test]
    fn unenrolled_speech_never_creates_a_voiceprint() {
        let dir = tempfile::tempdir().unwrap();
        let files = isolated_files(dir.path(), "fixture");
        let mut learner = Learner::new(&files);
        for _ in 0..6 {
            assert!(!confirmed(&mut learner, &files, None, vec![1., 0.]));
        }
        assert!(!files.pool.exists());
        assert!(!files.print.exists());
        assert_eq!(learner.added, 0);
    }
    #[test]
    fn pooling_uses_fixed_score_and_rebuilds_only_confirmed_speech() {
        let dir = tempfile::tempdir().unwrap();
        let files = isolated_files(dir.path(), "fixture");
        let mut learner = Learner::new(&files);
        assert!(!confirmed(
            &mut learner,
            &files,
            Some(&[1., 0.]),
            vec![1., 1.3]
        ));
        assert!(!confirmed(
            &mut learner,
            &files,
            Some(&[1., 0.]),
            vec![1., 2.2]
        ));
        assert_eq!(policy::segments(&files.pool, usize::MAX).len(), 1);
        assert_eq!(learner.held.len(), 2);
        assert_eq!(learner.added, 1);
        let other = isolated_files(dir.path(), "other");
        let mut fresh = Learner::new(&other);
        fresh.offset = fs::metadata(files.dir.join("voice-confirmed.jsonl"))
            .unwrap()
            .len();
        assert!(!confirmed(&mut fresh, &other, None, vec![1., 0.]));
        assert!(!other.pool.exists());
        assert_eq!(fresh.added, 0);
    }
    #[test]
    fn fifth_confirmed_segment_rebuilds_pool_and_preserves_pinned_threshold() {
        let dir = tempfile::tempdir().unwrap();
        let files = isolated_files(dir.path(), "fixture");
        write_json(
            &files.print,
            &json!({"vector":[1.,0.],"threshold":0.43,"threshold_pinned":true}),
        )
        .unwrap();
        let mut learner = Learner::new(&files);
        for i in 0..5 {
            assert_eq!(
                confirmed(&mut learner, &files, Some(&[1., 0.]), vec![1., 0.]),
                i == 4
            );
        }
        let saved = settings::read_file(&files.print);
        assert_eq!(saved["threshold"], 0.43);
        assert_eq!(saved["speech_seconds"], 40.);
        assert_eq!(saved["held_out_scores"].as_array().unwrap().len(), 5);
        assert_eq!(learner.added, 0);
    }
    #[test]
    fn clustering_rejects_outlier() {
        let v = vec![vec![1., 0.], vec![0.99, 0.1], vec![0., 1.]];
        let got = build(&v, &[2., 2., 10.], 0.4).unwrap();
        assert!(got[0] > 0.99);
        assert!(got[1] < 0.1);
    }
    #[test]
    fn thresholds_do_not_ratchet() {
        let cfg = settings::defaults();
        assert_eq!(adapted_threshold(&[0.9; 29], &json!({}), &cfg), 0.4);
        assert_eq!(adapted_threshold(&[0.9; 30], &json!({}), &cfg), 0.5);
        assert_eq!(
            adapted_threshold(
                &[0.9; 30],
                &json!({"threshold_pinned":true,"threshold":0.42}),
                &cfg
            ),
            0.42
        );
    }
}
