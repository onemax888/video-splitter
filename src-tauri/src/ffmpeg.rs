use chrono::{Duration as ChronoDuration, Local};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tiny_http::{Header, ListenAddr, Response, Server, StatusCode};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VideoInfo {
    pub path: String,
    pub duration: f64,
    pub duration_formatted: String,
    pub filename: String,
    pub file_size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SplitProgress {
    pub current_segment: u32,
    pub total_segments: u32,
    pub percentage: f64,
    pub current_file: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SplitResult {
    pub success: bool,
    pub output_files: Vec<String>,
    pub error: Option<String>,
    pub total_elapsed_ms: u64,
    pub segment_stats: Vec<SegmentStat>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SegmentStat {
    pub file: String,
    pub elapsed_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FFmpegStatus {
    pub found: bool,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
    pub version: Option<String>,
    pub os_info: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, Hash)]
#[serde(rename_all = "lowercase")]
pub enum AppendKind {
    Image,
    Video,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SeekMode {
    Accurate,
    Fast,
    Balanced,
}

const BALANCED_PAD_SECONDS: f64 = 2.0;
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppendSource {
    pub kind: AppendKind,
    pub path: String,
    pub duration_seconds: Option<f64>,
}

struct MediaParams {
    width: u32,
    height: u32,
    fps: f64,
    sample_rate: u32,
    channels: u32,
    has_audio: bool,
}

fn build_batch_output_dir(output_dir: &str, _input_path: &str) -> Result<String, String> {
    let now = Local::now();
    let base_dir = Path::new(output_dir);

    for i in 0..1000 {
        let candidate_time = now + ChronoDuration::seconds(i as i64);
        let name = format!(
            "{}",
            candidate_time.format("%Y%m%d_%H%M%S")
        );
        let candidate = base_dir.join(&name);
        if !candidate.exists() {
            std::fs::create_dir_all(&candidate)
                .map_err(|e| format!("创建输出目录失败: {}", e))?;
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    Err("无法生成唯一输出目录".to_string())
}

fn get_os_info() -> String {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    let os_name = match os {
        "macos" => "macOS",
        "linux" => "Linux",
        "windows" => "Windows",
        _ => os,
    };

    let arch_name = match arch {
        "x86_64" => "x64",
        "aarch64" => "ARM64",
        "x86" => "x86",
        _ => arch,
    };

    format!("{} ({})", os_name, arch_name)
}

pub async fn check_ffmpeg(app_handle: &AppHandle) -> FFmpegStatus {
    let os_info = get_os_info();
    let ffmpeg_sidecar = app_handle.shell().sidecar("ffmpeg");
    let ffprobe_sidecar = app_handle.shell().sidecar("ffprobe");

    if ffmpeg_sidecar.is_err() || ffprobe_sidecar.is_err() {
        return FFmpegStatus {
            found: false,
            ffmpeg_path: ffmpeg_sidecar.ok().map(|_| "sidecar:ffmpeg".to_string()),
            ffprobe_path: ffprobe_sidecar.ok().map(|_| "sidecar:ffprobe".to_string()),
            version: None,
            os_info,
            error: Some("内置 FFmpeg 未找到，请重新安装应用。".to_string()),
        };
    }

    let version = match app_handle.shell().sidecar("ffmpeg") {
        Ok(command) => match command.args(["-version"]).output().await {
            Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(|line| line.to_string()),
            _ => None,
        },
        Err(_) => None,
    };

    FFmpegStatus {
        found: true,
        ffmpeg_path: Some("sidecar:ffmpeg".to_string()),
        ffprobe_path: Some("sidecar:ffprobe".to_string()),
        version,
        os_info,
        error: None,
    }
}

pub async fn get_video_duration(app_handle: &AppHandle, path: &str) -> Result<f64, String> {
    let output = app_handle
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| format!("Failed to locate ffprobe sidecar: {}", e))?
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe failed: {}", stderr));
    }

    let duration_str = String::from_utf8_lossy(&output.stdout);
    duration_str
        .trim()
        .parse::<f64>()
        .map_err(|e| format!("Failed to parse duration: {}", e))
}

fn parse_fraction(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts.len() == 2 {
        let numerator: f64 = parts[0].parse().ok()?;
        let denominator: f64 = parts[1].parse().ok()?;
        if denominator == 0.0 {
            return None;
        }
        return Some(numerator / denominator);
    }
    trimmed.parse::<f64>().ok()
}

fn channel_layout(channels: u32) -> &'static str {
    match channels {
        1 => "mono",
        2 => "stereo",
        4 => "quad",
        6 => "5.1",
        8 => "7.1",
        _ => "stereo",
    }
}

fn scale_filter(width: u32, height: u32) -> String {
    format!(
        "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
        width, height, width, height
    )
}

async fn probe_media_params(app_handle: &AppHandle, path: &str) -> Result<MediaParams, String> {
    let output = app_handle
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| format!("Failed to locate ffprobe sidecar: {}", e))?
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            path,
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe failed: {}", stderr));
    }

    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;
    let streams = value
        .get("streams")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "ffprobe output missing streams".to_string())?;

    let video_stream = streams.iter().find(|s| {
        s.get("codec_type")
            .and_then(|v| v.as_str())
            .map(|t| t == "video")
            .unwrap_or(false)
    });

    let video_stream = video_stream.ok_or_else(|| "No video stream found".to_string())?;
    let width = video_stream
        .get("width")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "Failed to read video width".to_string())? as u32;
    let height = video_stream
        .get("height")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "Failed to read video height".to_string())? as u32;
    let fps_value = video_stream
        .get("avg_frame_rate")
        .and_then(|v| v.as_str())
        .and_then(parse_fraction)
        .or_else(|| {
            video_stream
                .get("r_frame_rate")
                .and_then(|v| v.as_str())
                .and_then(parse_fraction)
        })
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(30.0);

    let audio_stream = streams.iter().find(|s| {
        s.get("codec_type")
            .and_then(|v| v.as_str())
            .map(|t| t == "audio")
            .unwrap_or(false)
    });

    let has_audio = audio_stream.is_some();
    let sample_rate = audio_stream
        .and_then(|s| s.get("sample_rate"))
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(48_000);
    let channels = audio_stream
        .and_then(|s| s.get("channels"))
        .and_then(|v| v.as_u64())
        .unwrap_or(2) as u32;

    Ok(MediaParams {
        width,
        height,
        fps: fps_value,
        sample_rate,
        channels,
        has_audio,
    })
}

async fn probe_has_audio(app_handle: &AppHandle, path: &str) -> Result<bool, String> {
    let output = app_handle
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| format!("Failed to locate ffprobe sidecar: {}", e))?
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=channels",
            path,
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe failed: {}", stderr));
    }

    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;
    let streams = value.get("streams").and_then(|v| v.as_array());
    Ok(streams.map_or(false, |s| !s.is_empty()))
}

fn append_cache_key(source: &AppendSource, params: &MediaParams) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source.path.hash(&mut hasher);
    source.kind.hash(&mut hasher);
    if let Some(duration) = source.duration_seconds {
        duration.to_bits().hash(&mut hasher);
    }
    params.width.hash(&mut hasher);
    params.height.hash(&mut hasher);
    params.sample_rate.hash(&mut hasher);
    params.channels.hash(&mut hasher);
    params.fps.to_bits().hash(&mut hasher);

    if let Ok(metadata) = std::fs::metadata(&source.path) {
        metadata.len().hash(&mut hasher);
        if let Ok(modified) = metadata.modified() {
            if let Ok(duration) = modified.duration_since(SystemTime::UNIX_EPOCH) {
                duration.as_secs().hash(&mut hasher);
                duration.subsec_nanos().hash(&mut hasher);
            }
        }
    }

    hasher.finish()
}

async fn normalize_append_source(
    app_handle: &AppHandle,
    source: &AppendSource,
    params: &MediaParams,
) -> Result<String, String> {
    let source_path = Path::new(&source.path);
    if !source_path.exists() {
        return Err(format!("片头/片尾文件不存在: {}", source.path));
    }

    let cache_key = append_cache_key(source, params);
    let cache_dir = std::env::temp_dir()
        .join("video-splitter-append")
        .join(format!("{cache_key}"));
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create append cache dir: {}", e))?;
    let output_path = cache_dir.join("normalized.mp4");

    if output_path.exists() {
        return Ok(output_path.to_string_lossy().to_string());
    }

    let fps = if params.fps.is_finite() && params.fps > 0.0 {
        params.fps
    } else {
        30.0
    };
    let fps_str = format!("{:.3}", fps);
    let scale = scale_filter(params.width, params.height);
    let sample_rate = params.sample_rate;
    let channels = params.channels;
    let channel_layout = channel_layout(channels);
    let audio_source = format!(
        "anullsrc=channel_layout={}:sample_rate={}",
        channel_layout, sample_rate
    );

    let mut args: Vec<String> = vec!["-y".to_string()];

    match source.kind {
        AppendKind::Image => {
            let duration = source
                .duration_seconds
                .ok_or_else(|| "图片片头/片尾需要设置时长".to_string())?;
            if duration <= 0.0 {
                return Err("图片片头/片尾时长必须大于 0".to_string());
            }
            let duration_str = format!("{:.3}", duration);

            args.extend([
                "-loop".to_string(),
                "1".to_string(),
                "-t".to_string(),
                duration_str.clone(),
                "-i".to_string(),
                source.path.clone(),
                "-f".to_string(),
                "lavfi".to_string(),
                "-t".to_string(),
                duration_str,
                "-i".to_string(),
                audio_source,
                "-shortest".to_string(),
                "-r".to_string(),
                fps_str.clone(),
                "-vf".to_string(),
                scale,
                "-map".to_string(),
                "0:v:0".to_string(),
                "-map".to_string(),
                "1:a:0".to_string(),
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "veryfast".to_string(),
                "-crf".to_string(),
                "18".to_string(),
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                "192k".to_string(),
                "-ar".to_string(),
                sample_rate.to_string(),
                "-ac".to_string(),
                channels.to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
                output_path.to_string_lossy().to_string(),
            ]);
        }
        AppendKind::Video => {
            let has_audio = probe_has_audio(app_handle, &source.path).await?;

            args.extend(["-i".to_string(), source.path.clone()]);
            if !has_audio {
                args.extend([
                    "-f".to_string(),
                    "lavfi".to_string(),
                    "-i".to_string(),
                    audio_source,
                ]);
            }

            args.extend([
                "-r".to_string(),
                fps_str,
                "-vf".to_string(),
                scale,
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "veryfast".to_string(),
                "-crf".to_string(),
                "18".to_string(),
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                "192k".to_string(),
                "-ar".to_string(),
                sample_rate.to_string(),
                "-ac".to_string(),
                channels.to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);

            if has_audio {
                args.extend([
                    "-map".to_string(),
                    "0:v:0".to_string(),
                    "-map".to_string(),
                    "0:a:0?".to_string(),
                ]);
            } else {
                args.extend([
                    "-map".to_string(),
                    "0:v:0".to_string(),
                    "-map".to_string(),
                    "1:a:0".to_string(),
                    "-shortest".to_string(),
                ]);
            }

            args.push(output_path.to_string_lossy().to_string());
        }
    }

    let output = app_handle
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("Failed to locate ffmpeg sidecar: {}", e))?
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg failed: {}", stderr));
    }

    Ok(output_path.to_string_lossy().to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PreviewSource {
    pub kind: String,
    pub path: String,
}

struct HlsServerState {
    port: u16,
    dirs: Arc<Mutex<HashMap<String, std::path::PathBuf>>>,
    jobs: Arc<Mutex<HashMap<String, Instant>>>,
}

static HLS_SERVER: OnceLock<HlsServerState> = OnceLock::new();

fn ensure_hls_server() -> Result<&'static HlsServerState, String> {
    if let Some(server) = HLS_SERVER.get() {
        return Ok(server);
    }

    let server = Server::http("127.0.0.1:0")
        .map_err(|e| format!("Failed to start HLS server: {}", e))?;
    let port = match server.server_addr() {
        ListenAddr::IP(addr) => addr.port(),
        _ => return Err("Failed to determine HLS server port".to_string()),
    };

    let dirs = Arc::new(Mutex::new(HashMap::new()));
    let dirs_thread = dirs.clone();
    let jobs = Arc::new(Mutex::new(HashMap::new()));

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            handle_hls_request(request, &dirs_thread);
        }
    });

    let state = HlsServerState { port, dirs, jobs };
    if HLS_SERVER.set(state).is_err() {
        return HLS_SERVER
            .get()
            .ok_or_else(|| "Failed to initialize HLS server".to_string());
    }

    HLS_SERVER
        .get()
        .ok_or_else(|| "Failed to initialize HLS server".to_string())
}

fn handle_hls_request(request: tiny_http::Request, dirs: &Arc<Mutex<HashMap<String, std::path::PathBuf>>>) {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or(&url);
    let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();

    if parts.len() < 3 || parts[0] != "hls" {
        let response = Response::empty(StatusCode(404))
            .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap());
        let _ = request.respond(response);
        return;
    }

    let id = parts[1];
    let file_rel = parts[2..].join("/");
    if file_rel.contains("..") {
        let response = Response::empty(StatusCode(404))
            .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap());
        let _ = request.respond(response);
        return;
    }

    let dir = {
        let map = match dirs.lock() {
            Ok(m) => m,
            Err(_) => {
                let response = Response::empty(StatusCode(404))
                    .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap());
                let _ = request.respond(response);
                return;
            }
        };
        map.get(id).cloned()
    };

    let dir = match dir {
        Some(d) => d,
        None => {
            let response = Response::empty(StatusCode(404))
                .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap());
            let _ = request.respond(response);
            return;
        }
    };

    let file_path = dir.join(file_rel);
    let file = match std::fs::File::open(&file_path) {
        Ok(f) => f,
        Err(_) => {
            let response = Response::empty(StatusCode(404))
                .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap());
            let _ = request.respond(response);
            return;
        }
    };

    let extension = file_path.extension().and_then(|s| s.to_str());
    let content_type = match extension {
        Some("m3u8") => "application/vnd.apple.mpegurl",
        Some("ts") => "video/mp2t",
        Some("m4s") => "video/iso.segment",
        _ => "application/octet-stream",
    };

    let mut response = Response::from_file(file)
        .with_header(Header::from_bytes("Content-Type", content_type).unwrap())
        .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap());

    if matches!(extension, Some("m3u8")) {
        response = response.with_header(Header::from_bytes("Cache-Control", "no-store").unwrap());
    }
    let _ = request.respond(response);
}

fn register_hls_dir(id: &str, dir: &Path) -> Result<u16, String> {
    let server = ensure_hls_server()?;
    let mut map = server
        .dirs
        .lock()
        .map_err(|_| "Failed to lock HLS map".to_string())?;
    map.insert(id.to_string(), dir.to_path_buf());
    Ok(server.port)
}

fn playlist_has_segments(path: &Path) -> bool {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(_) => return false,
    };

    contents.lines().any(|line| {
        let trimmed = line.trim();
        !trimmed.is_empty() && !trimmed.starts_with('#')
    })
}

pub async fn prepare_hls_source(
    app_handle: &AppHandle,
    input_path: &str,
    min_size_bytes: u64,
    segment_seconds: u64,
    start_seconds: Option<f64>,
    window_seconds: Option<u64>,
) -> Result<PreviewSource, String> {
    let metadata = std::fs::metadata(input_path)
        .map_err(|e| format!("Failed to read input metadata: {}", e))?;
    let file_size = metadata.len();

    if file_size < min_size_bytes {
        return Ok(PreviewSource {
            kind: "file".to_string(),
            path: input_path.to_string(),
        });
    }

    let segment_seconds = segment_seconds.max(2);
    let window_seconds = window_seconds.unwrap_or(600).max(segment_seconds * 3);
    let start_seconds = start_seconds.unwrap_or(0.0);
    let start_seconds = if start_seconds.is_finite() {
        start_seconds.max(0.0)
    } else {
        0.0
    };
    let aligned_start = (start_seconds / segment_seconds as f64).floor() * segment_seconds as f64;
    let aligned_start_key = (aligned_start * 1000.0).round() as u64;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input_path.hash(&mut hasher);
    file_size.hash(&mut hasher);
    segment_seconds.hash(&mut hasher);
    window_seconds.hash(&mut hasher);
    aligned_start_key.hash(&mut hasher);
    if let Ok(modified) = metadata.modified() {
        if let Ok(duration) = modified.duration_since(SystemTime::UNIX_EPOCH) {
            duration.as_secs().hash(&mut hasher);
            duration.subsec_nanos().hash(&mut hasher);
        }
    }
    let hash = hasher.finish();

    let hls_dir = std::env::temp_dir()
        .join("video-splitter-hls")
        .join(format!("{hash}"));
    let playlist_path = hls_dir.join("index.m3u8");
    let hls_id = format!("{hash}");

    if playlist_path.exists() && playlist_has_segments(&playlist_path) {
        let port = register_hls_dir(&hls_id, &hls_dir)?;
        return Ok(PreviewSource {
            kind: "hls".to_string(),
            path: format!("http://127.0.0.1:{port}/hls/{hls_id}/index.m3u8"),
        });
    }

    std::fs::create_dir_all(&hls_dir)
        .map_err(|e| format!("Failed to create HLS dir: {}", e))?;

    let server = ensure_hls_server()?;
    let spawn_needed = {
        let mut jobs = server
            .jobs
            .lock()
            .map_err(|_| "Failed to lock HLS job map".to_string())?;
        match jobs.get(&hls_id) {
            Some(started) if started.elapsed() < Duration::from_secs(30) => false,
            _ => {
                jobs.insert(hls_id.clone(), Instant::now());
                true
            }
        }
    };

    if spawn_needed {
        let force_key_frames = format!("expr:gte(t,n_forced*{segment_seconds})");
        let aligned_start_str = format!("{:.3}", aligned_start);

        let mut args: Vec<String> = Vec::new();
        args.extend([
            "-y".to_string(),
            "-ss".to_string(),
            aligned_start_str,
            "-i".to_string(),
            input_path.to_string(),
            "-t".to_string(),
            window_seconds.to_string(),
            "-map".to_string(),
            "0:v:0?".to_string(),
            "-map".to_string(),
            "0:a:0?".to_string(),
        ]);
        args.extend([
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "ultrafast".to_string(),
            "-crf".to_string(),
            "28".to_string(),
            "-force_key_frames".to_string(),
            force_key_frames,
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "96k".to_string(),
            "-hls_time".to_string(),
            segment_seconds.to_string(),
            "-hls_list_size".to_string(),
            "0".to_string(),
            "-hls_playlist_type".to_string(),
            "event".to_string(),
            "-hls_flags".to_string(),
            "independent_segments".to_string(),
            "-hls_segment_filename".to_string(),
            "segment_%05d.ts".to_string(),
            "index.m3u8".to_string(),
        ]);

        let _ = app_handle
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| format!("Failed to locate ffmpeg sidecar: {}", e))?
            .current_dir(&hls_dir)
            .args(args)
            .spawn()
            .map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;
    }

    let start = Instant::now();
    loop {
        if playlist_path.exists() && playlist_has_segments(&playlist_path) {
            break;
        }

        if start.elapsed() > Duration::from_secs(30) {
            if let Ok(mut jobs) = server.jobs.lock() {
                jobs.remove(&hls_id);
            }
            return Err("HLS 分片生成超时，请重试".to_string());
        }

        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    if let Ok(mut jobs) = server.jobs.lock() {
        jobs.remove(&hls_id);
    }

    let port = register_hls_dir(&hls_id, &hls_dir)?;

    Ok(PreviewSource {
        kind: "hls".to_string(),
        path: format!("http://127.0.0.1:{port}/hls/{hls_id}/index.m3u8"),
    })
}

pub fn format_duration(seconds: f64) -> String {
    let hours = (seconds / 3600.0).floor() as u32;
    let minutes = ((seconds % 3600.0) / 60.0).floor() as u32;
    let secs = (seconds % 60.0).floor() as u32;
    format!("{:02}:{:02}:{:02}", hours, minutes, secs)
}

fn elapsed_ms(start: Instant) -> u64 {
    let elapsed = start.elapsed().as_millis();
    if elapsed > u64::MAX as u128 {
        u64::MAX
    } else {
        elapsed as u64
    }
}

fn build_ranges_from_interval(total_duration: f64, segment_duration: u32) -> Vec<TimeRange> {
    if segment_duration == 0 || total_duration <= 0.0 {
        return Vec::new();
    }

    let segment = segment_duration as f64;
    let mut ranges = Vec::new();
    let mut start = 0.0;
    while start < total_duration {
        let end = (start + segment).min(total_duration);
        ranges.push(TimeRange {
            start_seconds: start,
            end_seconds: end,
            label: None,
        });
        start = end;
    }
    ranges
}

fn build_concat_filter(pairs: &[(String, String)]) -> String {
    let mut filter = String::new();
    for (video, audio) in pairs {
        filter.push_str(video);
        filter.push_str(audio);
    }
    filter.push_str(&format!(
        "concat=n={}:v=1:a=1[outv][outa]",
        pairs.len()
    ));
    filter
}

fn sanitize_segment_label(label: &str) -> Option<String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut cleaned = String::new();
    for ch in trimmed.chars() {
        if ch.is_whitespace() {
            cleaned.push('_');
            continue;
        }
        if ch.is_control() {
            continue;
        }
        match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => continue,
            _ => cleaned.push(ch),
        }
    }

    let cleaned = cleaned.trim_matches('.');
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn build_segment_filename(
    output_dir: &str,
    index: usize,
    extension: &str,
    label: Option<&str>,
) -> String {
    let label_suffix = label
        .and_then(sanitize_segment_label)
        .map(|value| format!("_{}", value))
        .unwrap_or_default();

    format!("{}/{:03}{}.{}", output_dir, index, label_suffix, extension)
}

pub async fn split_video_with_append(
    app_handle: &AppHandle,
    input_path: &str,
    output_dir: &str,
    segment_duration: u32,
    ranges: Option<Vec<TimeRange>>,
    intro: Option<AppendSource>,
    outro: Option<AppendSource>,
) -> Result<SplitResult, String> {
    let overall_start = Instant::now();
    let ranges = if let Some(ranges) = ranges {
        ranges
    } else {
        let total_duration = get_video_duration(app_handle, input_path).await?;
        build_ranges_from_interval(total_duration, segment_duration)
    };
    let output_dir = build_batch_output_dir(output_dir, input_path)?;

    if ranges.is_empty() {
        return Err("没有可用的切分范围".to_string());
    }

    let params = probe_media_params(app_handle, input_path).await?;
    let intro_path = match intro.as_ref() {
        Some(source) => Some(normalize_append_source(app_handle, source, &params).await?),
        None => None,
    };
    let outro_path = match outro.as_ref() {
        Some(source) => Some(normalize_append_source(app_handle, source, &params).await?),
        None => None,
    };

    let path = std::path::Path::new(input_path);
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");

    let total_segments = ranges.len() as u32;
    let mut output_files = Vec::new();
    let mut segment_stats = Vec::new();

    for (i, range) in ranges.iter().enumerate() {
        let segment_len = range.end_seconds - range.start_seconds;
        if segment_len <= 0.0 {
            return Err(format!("片段时长无效: {}", segment_len));
        }

        let progress = SplitProgress {
            current_segment: i as u32 + 1,
            total_segments,
            percentage: ((i as f64) / (total_segments as f64)) * 100.0,
            current_file: format!("正在切分片段 {}/{}...", i + 1, total_segments),
        };
        let _ = app_handle.emit("split-progress", &progress);

        let output_file = build_segment_filename(
            &output_dir,
            i,
            extension,
            range.label.as_deref(),
        );
        let start_time = format!("{:.3}", range.start_seconds);
        let duration_str = format!("{:.3}", segment_len);
        let segment_start = Instant::now();

        let mut args: Vec<String> = vec!["-y".to_string()];
        let mut pairs: Vec<(String, String)> = Vec::new();
        let mut input_index = 0;

        if let Some(intro_file) = intro_path.as_ref() {
            args.extend(["-i".to_string(), intro_file.clone()]);
            pairs.push((
                format!("[{}:v]", input_index),
                format!("[{}:a]", input_index),
            ));
            input_index += 1;
        }

        args.extend([
            "-ss".to_string(),
            start_time,
            "-t".to_string(),
            duration_str.clone(),
            "-i".to_string(),
            input_path.to_string(),
        ]);
        let main_index = input_index;
        input_index += 1;

        let mut silent_audio_index = None;
        if !params.has_audio {
            let audio_source = format!(
                "anullsrc=channel_layout={}:sample_rate={}",
                channel_layout(params.channels),
                params.sample_rate
            );
            args.extend([
                "-f".to_string(),
                "lavfi".to_string(),
                "-t".to_string(),
                duration_str,
                "-i".to_string(),
                audio_source,
            ]);
            silent_audio_index = Some(input_index);
            input_index += 1;
        }

        let audio_index = if params.has_audio {
            main_index
        } else {
            silent_audio_index.ok_or_else(|| "Failed to build silent audio".to_string())?
        };
        pairs.push((
            format!("[{}:v]", main_index),
            format!("[{}:a]", audio_index),
        ));

        if let Some(outro_file) = outro_path.as_ref() {
            args.extend(["-i".to_string(), outro_file.clone()]);
            pairs.push((
                format!("[{}:v]", input_index),
                format!("[{}:a]", input_index),
            ));
        }

        let filter = build_concat_filter(&pairs);

        let fps = if params.fps.is_finite() && params.fps > 0.0 {
            params.fps
        } else {
            30.0
        };

        args.extend([
            "-filter_complex".to_string(),
            filter,
            "-map".to_string(),
            "[outv]".to_string(),
            "-map".to_string(),
            "[outa]".to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "veryfast".to_string(),
            "-crf".to_string(),
            "18".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "192k".to_string(),
            "-ar".to_string(),
            params.sample_rate.to_string(),
            "-ac".to_string(),
            params.channels.to_string(),
            "-r".to_string(),
            format!("{:.3}", fps),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
            output_file.clone(),
        ]);

        let output = app_handle
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| format!("Failed to locate ffmpeg sidecar: {}", e))?
            .args(args)
            .output()
            .await
            .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("FFmpeg failed on segment {}: {}", i + 1, stderr));
        }

        if std::path::Path::new(&output_file).exists() {
            output_files.push(output_file.clone());
            segment_stats.push(SegmentStat {
                file: output_file,
                elapsed_ms: Some(elapsed_ms(segment_start)),
            });
        }
    }

    let final_progress = SplitProgress {
        current_segment: total_segments,
        total_segments,
        percentage: 100.0,
        current_file: "完成".to_string(),
    };
    let _ = app_handle.emit("split-progress", &final_progress);

    Ok(SplitResult {
        success: true,
        output_files,
        error: None,
        total_elapsed_ms: elapsed_ms(overall_start),
        segment_stats,
    })
}

pub async fn split_video(
    app_handle: &AppHandle,
    input_path: &str,
    output_dir: &str,
    segment_duration: u32,
) -> Result<SplitResult, String> {
    let overall_start = Instant::now();
    let total_duration = get_video_duration(app_handle, input_path).await?;
    let total_segments = (total_duration / segment_duration as f64).ceil() as u32;
    let output_dir = build_batch_output_dir(output_dir, input_path)?;

    let path = std::path::Path::new(input_path);
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");

    let progress = SplitProgress {
        current_segment: 0,
        total_segments,
        percentage: 0.0,
        current_file: "正在切分...".to_string(),
    };
    let _ = app_handle.emit("split-progress", &progress);

    let output_pattern = format!("{}/%03d.{}", output_dir, extension);

    let output = app_handle
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("Failed to locate ffmpeg sidecar: {}", e))?
        .args([
            "-y",
            "-i",
            input_path,
            "-c",
            "copy",
            "-map",
            "0",
            // Camera metadata tracks (e.g. XAVC rtmd) cannot be remuxed into MP4.
            "-dn",
            "-f",
            "segment",
            "-segment_time",
            &segment_duration.to_string(),
            "-reset_timestamps",
            "1",
            "-break_non_keyframes",
            "0",
            &output_pattern,
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg failed: {}", stderr));
    }

    let mut output_files = Vec::new();
    for i in 0..total_segments + 5 {
        let file_path = format!("{}/{:03}.{}", output_dir, i, extension);
        if std::path::Path::new(&file_path).exists() {
            output_files.push(file_path);
        } else {
            break;
        }
    }

    if output_files.is_empty() {
        return Err("FFmpeg 未生成任何片段".to_string());
    }

    let segment_stats = output_files
        .iter()
        .map(|file| SegmentStat {
            file: file.clone(),
            elapsed_ms: None,
        })
        .collect::<Vec<_>>();

    let final_progress = SplitProgress {
        current_segment: output_files.len() as u32,
        total_segments: output_files.len() as u32,
        percentage: 100.0,
        current_file: "完成".to_string(),
    };
    let _ = app_handle.emit("split-progress", &final_progress);

    Ok(SplitResult {
        success: true,
        output_files,
        error: None,
        total_elapsed_ms: elapsed_ms(overall_start),
        segment_stats,
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TimeRange {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub label: Option<String>,
}

pub async fn split_video_by_ranges(
    app_handle: &AppHandle,
    input_path: &str,
    output_dir: &str,
    ranges: Vec<TimeRange>,
    seek_mode: SeekMode,
    fast_copy_threshold_seconds: Option<u32>,
) -> Result<SplitResult, String> {
    let overall_start = Instant::now();
    let output_dir = build_batch_output_dir(output_dir, input_path)?;
    let path = std::path::Path::new(input_path);
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");

    let total_segments = ranges.len() as u32;
    let mut output_files = Vec::new();
    let mut segment_stats = Vec::new();

    for (i, range) in ranges.iter().enumerate() {
        let segment_len = range.end_seconds - range.start_seconds;
        if segment_len <= 0.0 {
            return Err(format!("片段时长无效: {}", segment_len));
        }

        let use_fast_copy = fast_copy_threshold_seconds
            .filter(|threshold| *threshold > 0)
            .map(|threshold| segment_len >= threshold as f64)
            .unwrap_or(false);

        let progress = SplitProgress {
            current_segment: i as u32 + 1,
            total_segments,
            percentage: ((i as f64) / (total_segments as f64)) * 100.0,
            current_file: format!("正在切分片段 {}/{}...", i + 1, total_segments),
        };
        let _ = app_handle.emit("split-progress", &progress);

        let output_file = build_segment_filename(
            &output_dir,
            i,
            extension,
            range.label.as_deref(),
        );
        let start_time = format!("{:.3}", range.start_seconds);
        let end_time = format!("{:.3}", range.end_seconds);
        let duration_str = format!("{:.3}", segment_len);
        let segment_start = Instant::now();

        let mut args: Vec<String> = vec!["-y".to_string()];

        if use_fast_copy {
            args.extend([
                "-ss".to_string(),
                start_time,
                "-t".to_string(),
                duration_str,
                "-i".to_string(),
                input_path.to_string(),
                "-map".to_string(),
                "0".to_string(),
                "-map".to_string(),
                "-0:v:disp:attached_pic".to_string(),
                "-c".to_string(),
                "copy".to_string(),
                "-avoid_negative_ts".to_string(),
                "1".to_string(),
                "-reset_timestamps".to_string(),
                "1".to_string(),
                output_file.clone(),
            ]);
        } else {
            match seek_mode {
                SeekMode::Fast => {
                    args.extend([
                        "-ss".to_string(),
                        start_time,
                        "-t".to_string(),
                        duration_str,
                        "-i".to_string(),
                        input_path.to_string(),
                    ]);
                }
                SeekMode::Balanced => {
                    let pre_seek = (range.start_seconds - BALANCED_PAD_SECONDS).max(0.0);
                    let post_seek = range.start_seconds - pre_seek;
                    let pre_seek_str = format!("{:.3}", pre_seek);
                    let post_seek_str = format!("{:.3}", post_seek);

                    args.extend([
                        "-ss".to_string(),
                        pre_seek_str,
                        "-i".to_string(),
                        input_path.to_string(),
                        "-ss".to_string(),
                        post_seek_str,
                        "-t".to_string(),
                        duration_str,
                    ]);
                }
                SeekMode::Accurate => {
                    args.extend([
                        "-i".to_string(),
                        input_path.to_string(),
                        "-ss".to_string(),
                        start_time,
                        "-to".to_string(),
                        end_time,
                    ]);
                }
            }

            args.extend([
                "-map".to_string(),
                "0".to_string(),
                "-map".to_string(),
                "-0:v:disp:attached_pic".to_string(),
                "-c:v".to_string(),
                "libx264".to_string(),
                "-c:a".to_string(),
                "aac".to_string(),
                "-c:s".to_string(),
                "copy".to_string(),
                "-c:d".to_string(),
                "copy".to_string(),
                "-preset".to_string(),
                "veryfast".to_string(),
                "-crf".to_string(),
                "18".to_string(),
                "-reset_timestamps".to_string(),
                "1".to_string(),
                output_file.clone(),
            ]);
        }

        let output = app_handle
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| format!("Failed to locate ffmpeg sidecar: {}", e))?
            .args(args)
            .output()
            .await
            .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("FFmpeg failed on segment {}: {}", i + 1, stderr));
        }

        if std::path::Path::new(&output_file).exists() {
            output_files.push(output_file.clone());
            segment_stats.push(SegmentStat {
                file: output_file,
                elapsed_ms: Some(elapsed_ms(segment_start)),
            });
        }
    }

    let final_progress = SplitProgress {
        current_segment: total_segments,
        total_segments,
        percentage: 100.0,
        current_file: "完成".to_string(),
    };
    let _ = app_handle.emit("split-progress", &final_progress);

    Ok(SplitResult {
        success: true,
        output_files,
        error: None,
        total_elapsed_ms: elapsed_ms(overall_start),
        segment_stats,
    })
}
