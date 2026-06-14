use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptionModel {
    WhisperCpp,
    FunAsr,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub model: TranscriptionModel,
    pub source_path: String,
    pub audio_path: String,
    pub text_path: String,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionProgress {
    pub task_id: String,
    pub stage: String,
    pub percentage: f64,
    pub message: String,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WhisperCppModelInfo {
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WhisperCppInfo {
    pub ok: bool,
    pub root_path: String,
    pub bin_path: Option<String>,
    pub models: Vec<WhisperCppModelInfo>,
    pub default_model_path: Option<String>,
    pub error: Option<String>,
}

pub async fn transcribe_media(
    app_handle: &AppHandle,
    source_path: &str,
    model: TranscriptionModel,
    whisper_cpp_dir: Option<String>,
    whisper_model_path: Option<String>,
    task_id: Option<String>,
) -> Result<TranscriptionResult, String> {
    emit_progress(
        app_handle,
        task_id.as_deref(),
        "preparing",
        2.0,
        "准备转写",
        Some(source_path),
    );
    let source_path = Path::new(source_path);
    if !source_path.exists() {
        return Err("转写源文件不存在".to_string());
    }

    let work_dir = transcription_dir(source_path)?;
    let audio_path =
        ensure_audio_source(app_handle, source_path, &work_dir, task_id.as_deref()).await?;
    let text = match model {
        TranscriptionModel::WhisperCpp => {
            transcribe_with_whisper_cpp(
                app_handle,
                &audio_path,
                &work_dir,
                whisper_cpp_dir.as_deref(),
                whisper_model_path.as_deref(),
                task_id.as_deref(),
            )
            .await?
        }
        TranscriptionModel::FunAsr => {
            transcribe_with_fun_asr(app_handle, &audio_path, &work_dir, task_id.as_deref()).await?
        }
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("转写完成但未生成文字内容".to_string());
    }

    emit_progress(
        app_handle,
        task_id.as_deref(),
        "saving",
        96.0,
        "保存转写文本",
        None,
    );
    let text_path = work_dir.join(format!(
        "transcript-{}-{}.txt",
        model_slug(model),
        Local::now().format("%Y%m%d%H%M%S")
    ));
    tokio::fs::write(&text_path, &text)
        .await
        .map_err(|e| format!("保存转写文本失败: {}", e))?;

    let result = TranscriptionResult {
        model,
        source_path: source_path.to_string_lossy().to_string(),
        audio_path: audio_path.to_string_lossy().to_string(),
        text_path: text_path.to_string_lossy().to_string(),
        text,
    };
    emit_progress(
        app_handle,
        task_id.as_deref(),
        "done",
        100.0,
        "转写完成",
        Some(result.text_path.as_str()),
    );
    Ok(result)
}

pub fn inspect_whisper_cpp(root: &str) -> WhisperCppInfo {
    let root = root.trim();
    if root.is_empty() {
        return WhisperCppInfo {
            ok: false,
            root_path: String::new(),
            bin_path: None,
            models: vec![],
            default_model_path: None,
            error: Some("请填写 whisper.cpp 根目录".to_string()),
        };
    }

    let root_path = Path::new(root);
    if !root_path.exists() {
        return WhisperCppInfo {
            ok: false,
            root_path: root.to_string(),
            bin_path: None,
            models: vec![],
            default_model_path: None,
            error: Some(format!("whisper.cpp 目录不存在: {}", root)),
        };
    }
    if !root_path.is_dir() {
        return WhisperCppInfo {
            ok: false,
            root_path: root.to_string(),
            bin_path: None,
            models: vec![],
            default_model_path: None,
            error: Some(format!("whisper.cpp 路径不是目录: {}", root)),
        };
    }

    let bin_result = find_whisper_bin_in_dir(root_path);
    let model_result = discover_whisper_models(root_path);
    let default_model_path = model_result
        .as_ref()
        .ok()
        .and_then(|models| default_whisper_model_path(models));
    let models = model_result
        .as_ref()
        .map(|paths| {
            paths
                .iter()
                .map(|path| {
                    let path_string = path.to_string_lossy().to_string();
                    WhisperCppModelInfo {
                        name: path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("unknown")
                            .to_string(),
                        is_default: default_model_path.as_deref() == Some(path_string.as_str()),
                        path: path_string,
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let error = match (&bin_result, &model_result) {
        (Err(bin_error), Err(model_error)) => Some(format!("{}；{}", bin_error, model_error)),
        (Err(error), _) | (_, Err(error)) => Some(error.clone()),
        _ => None,
    };

    WhisperCppInfo {
        ok: bin_result.is_ok() && model_result.is_ok() && !models.is_empty(),
        root_path: root.to_string(),
        bin_path: bin_result.ok(),
        models,
        default_model_path,
        error,
    }
}

async fn ensure_audio_source(
    app_handle: &AppHandle,
    source_path: &Path,
    work_dir: &Path,
    task_id: Option<&str>,
) -> Result<PathBuf, String> {
    if is_audio_file(source_path) {
        emit_progress(
            app_handle,
            task_id,
            "extracting",
            35.0,
            "使用已有音频",
            Some(source_path.to_string_lossy().as_ref()),
        );
        return Ok(source_path.to_path_buf());
    }

    let audio_path = work_dir.join("transcription-audio.wav");
    let source_arg = source_path.to_string_lossy().to_string();
    let audio_arg = audio_path.to_string_lossy().to_string();
    let duration = crate::ffmpeg::get_video_duration(app_handle, source_arg.as_str())
        .await
        .ok();
    emit_progress(
        app_handle,
        task_id,
        "extracting",
        8.0,
        "正在分离音频",
        Some(source_arg.as_str()),
    );

    let args = [
        "-y",
        "-i",
        source_arg.as_str(),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        "-progress",
        "pipe:1",
        "-nostats",
        audio_arg.as_str(),
    ];
    let (mut rx, _child) = app_handle
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("FFmpeg sidecar 不可用，无法从视频分离音频: {}", e))?
        .args(args)
        .spawn()
        .map_err(|e| format!("分离音频失败: {}", e))?;

    let mut stderr = String::new();
    let mut exit_code = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                if let Some(percent) = parse_ffmpeg_progress(line.trim(), duration) {
                    emit_progress(
                        app_handle,
                        task_id,
                        "extracting",
                        8.0 + percent * 0.27,
                        "正在分离音频",
                        Some(source_arg.as_str()),
                    );
                }
            }
            CommandEvent::Stderr(bytes) => {
                stderr.push_str(&String::from_utf8_lossy(&bytes));
                keep_recent_chars(&mut stderr, 4000);
            }
            CommandEvent::Error(error) => {
                stderr.push_str(&error);
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            _ => {}
        }
    }

    if exit_code == Some(0) && audio_path.exists() {
        emit_progress(
            app_handle,
            task_id,
            "extracting",
            35.0,
            "音频分离完成",
            Some(audio_arg.as_str()),
        );
        return Ok(audio_path);
    }

    Err(format!("分离音频失败: {}", stderr.trim()))
}

async fn transcribe_with_whisper_cpp(
    app_handle: &AppHandle,
    audio_path: &Path,
    work_dir: &Path,
    whisper_cpp_dir: Option<&str>,
    whisper_model_path: Option<&str>,
    task_id: Option<&str>,
) -> Result<String, String> {
    let config = resolve_whisper_cpp_config(whisper_cpp_dir, whisper_model_path)?;
    let output_base = work_dir.join(format!("whisper-{}", Local::now().format("%Y%m%d%H%M%S")));
    let audio_arg = audio_path.to_string_lossy().to_string();
    let output_arg = output_base.to_string_lossy().to_string();

    emit_progress(
        app_handle,
        task_id,
        "transcribing",
        40.0,
        "正在加载 whisper.cpp",
        Some(config.model_path.as_str()),
    );

    let args = [
        "-m",
        config.model_path.as_str(),
        "-f",
        audio_arg.as_str(),
        "-otxt",
        "-of",
        output_arg.as_str(),
        "-pp",
    ];
    let (mut rx, _child) = app_handle
        .shell()
        .command(config.bin_path.as_str())
        .args(args)
        .spawn()
        .map_err(|e| format!("运行 whisper.cpp 失败: {}", e))?;

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                stdout.push_str(&line);
                if let Some(percent) = parse_percent_progress(&line) {
                    emit_progress(
                        app_handle,
                        task_id,
                        "transcribing",
                        40.0 + percent * 0.55,
                        "whisper.cpp 转写中",
                        Some(line.trim()),
                    );
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                stderr.push_str(&line);
                if let Some(percent) = parse_percent_progress(&line) {
                    emit_progress(
                        app_handle,
                        task_id,
                        "transcribing",
                        40.0 + percent * 0.55,
                        "whisper.cpp 转写中",
                        Some(line.trim()),
                    );
                }
            }
            CommandEvent::Error(error) => {
                stderr.push_str(&error);
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            _ => {}
        }
        keep_recent_chars(&mut stdout, 8000);
        keep_recent_chars(&mut stderr, 8000);
    }

    let text_path = output_base.with_extension("txt");
    if exit_code == Some(0) {
        emit_progress(
            app_handle,
            task_id,
            "transcribing",
            95.0,
            "whisper.cpp 转写完成",
            None,
        );
        if text_path.exists() {
            return tokio::fs::read_to_string(&text_path)
                .await
                .map_err(|e| format!("读取 whisper.cpp 输出失败: {}", e));
        }
        if !stdout.trim().is_empty() {
            return Ok(stdout);
        }
    }

    Err(format!("whisper.cpp 转写失败: {}", stderr.trim()))
}

struct WhisperCppConfig {
    bin_path: String,
    model_path: String,
}

fn resolve_whisper_cpp_config(
    whisper_cpp_dir: Option<&str>,
    whisper_model_path: Option<&str>,
) -> Result<WhisperCppConfig, String> {
    if let Some(root) = whisper_cpp_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let root = Path::new(root);
        if !root.exists() {
            return Err(format!(
                "whisper.cpp 目录不存在: {}",
                root.to_string_lossy()
            ));
        }
        return Ok(WhisperCppConfig {
            bin_path: find_whisper_bin_in_dir(root)?,
            model_path: resolve_whisper_model_path(root, whisper_model_path)?,
        });
    }

    let bin_path = find_executable("WHISPER_CPP_BIN", &["whisper-cli", "whisper-cpp", "main"])?;
    let model_path = whisper_model_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| std::env::var("WHISPER_CPP_MODEL").ok())
        .ok_or_else(|| {
            "请在设置里配置 whisper.cpp 目录，或设置 WHISPER_CPP_MODEL 指向模型文件".to_string()
        })?;
    if !Path::new(&model_path).exists() {
        return Err(format!("whisper.cpp 模型文件不存在: {}", model_path));
    }

    Ok(WhisperCppConfig {
        bin_path,
        model_path,
    })
}

fn find_whisper_bin_in_dir(root: &Path) -> Result<String, String> {
    let candidates = [
        "build/bin/whisper-cli",
        "build/bin/main",
        "build/bin/Release/whisper-cli",
        "build/bin/Release/main",
        "whisper-cli",
        "main",
    ];

    for candidate in candidates {
        let path = root.join(candidate);
        if path.exists() {
            return Ok(path.to_string_lossy().to_string());
        }
    }

    Err(format!(
        "未在 whisper.cpp 目录中找到 whisper-cli/main，请先编译 whisper.cpp: {}",
        root.to_string_lossy()
    ))
}

fn resolve_whisper_model_path(
    root: &Path,
    whisper_model_path: Option<&str>,
) -> Result<String, String> {
    if let Some(path) = whisper_model_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let model_path = Path::new(path);
        if model_path.exists() && model_path.is_file() {
            return Ok(model_path.to_string_lossy().to_string());
        }
        return Err(format!("选择的 whisper.cpp 模型文件不存在: {}", path));
    }

    find_whisper_model_in_dir(root)
}

fn find_whisper_model_in_dir(root: &Path) -> Result<String, String> {
    let models = discover_whisper_models(root)?;
    default_whisper_model_path(&models).ok_or_else(|| {
        format!(
            "未在 {} 中找到 ggml-*.bin 模型文件",
            root.join("models").to_string_lossy()
        )
    })
}

fn discover_whisper_models(root: &Path) -> Result<Vec<PathBuf>, String> {
    let model_dir = root.join("models");
    if !model_dir.exists() {
        return Err(format!(
            "未找到 whisper.cpp 模型目录: {}",
            model_dir.to_string_lossy()
        ));
    }

    let mut discovered = std::fs::read_dir(&model_dir)
        .map_err(|e| format!("读取 whisper.cpp 模型目录失败: {}", e))?
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("ggml-") && name.ends_with(".bin"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    discovered.sort_by(|left, right| {
        let left_name = left
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        let right_name = right
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        whisper_model_rank(left_name)
            .cmp(&whisper_model_rank(right_name))
            .then_with(|| left_name.cmp(right_name))
    });

    if discovered.is_empty() {
        return Err(format!(
            "未在 {} 中找到 ggml-*.bin 模型文件",
            model_dir.to_string_lossy()
        ));
    }

    Ok(discovered)
}

fn default_whisper_model_path(models: &[PathBuf]) -> Option<String> {
    models
        .first()
        .map(|path| path.to_string_lossy().to_string())
}

fn whisper_model_rank(name: &str) -> usize {
    [
        "ggml-large-v3-turbo.bin",
        "ggml-large-v3.bin",
        "ggml-large-v2.bin",
        "ggml-large.bin",
        "ggml-medium.bin",
        "ggml-small.bin",
        "ggml-base.bin",
        "ggml-tiny.bin",
    ]
    .iter()
    .position(|item| *item == name)
    .unwrap_or(usize::MAX)
}

async fn transcribe_with_fun_asr(
    app_handle: &AppHandle,
    audio_path: &Path,
    work_dir: &Path,
    task_id: Option<&str>,
) -> Result<String, String> {
    let bin = find_executable("FUNASR_BIN", &["funasr", "funasr-runtime"])?;
    let audio_arg = audio_path.to_string_lossy().to_string();
    let output_dir = work_dir.join(format!("funasr-{}", Local::now().format("%Y%m%d%H%M%S")));
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|e| format!("创建 FunASR 输出目录失败: {}", e))?;
    let output_arg = output_dir.to_string_lossy().to_string();
    let model = std::env::var("FUNASR_MODEL").unwrap_or_else(|_| "paraformer-zh".to_string());
    let vad_model = std::env::var("FUNASR_VAD_MODEL").unwrap_or_else(|_| "fsmn-vad".to_string());
    let punc_model = std::env::var("FUNASR_PUNC_MODEL").unwrap_or_else(|_| "ct-punc".to_string());

    emit_progress(
        app_handle,
        task_id,
        "transcribing",
        45.0,
        "FunASR 转写中",
        Some(audio_arg.as_str()),
    );
    let output = Command::new(&bin)
        .args([
            format!("++model={}", model),
            format!("++vad_model={}", vad_model),
            format!("++punc_model={}", punc_model),
            format!("++input={}", audio_arg),
            format!("++output_dir={}", output_arg),
        ])
        .output()
        .await
        .map_err(|e| format!("运行 FunASR 失败: {}", e))?;

    if output.status.success() {
        emit_progress(
            app_handle,
            task_id,
            "transcribing",
            95.0,
            "FunASR 转写完成",
            None,
        );
        if let Some(text) = read_first_text_file(&output_dir).await? {
            return Ok(text);
        }
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if !stdout.trim().is_empty() {
            return Ok(stdout);
        }
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!("FunASR 转写失败: {}", stderr.trim()))
}

async fn read_first_text_file(dir: &Path) -> Result<Option<String>, String> {
    let mut entries = tokio::fs::read_dir(dir)
        .await
        .map_err(|e| format!("读取 FunASR 输出目录失败: {}", e))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("读取 FunASR 输出失败: {}", e))?
    {
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        if matches!(ext, "txt" | "json" | "srt" | "vtt") {
            return tokio::fs::read_to_string(path)
                .await
                .map(Some)
                .map_err(|e| format!("读取 FunASR 文本失败: {}", e));
        }
    }
    Ok(None)
}

fn transcription_dir(source_path: &Path) -> Result<PathBuf, String> {
    let parent = source_path.parent().unwrap_or_else(|| Path::new("."));
    let dir = parent.join("_transcripts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建转写目录失败: {}", e))?;
    Ok(dir)
}

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            matches!(
                ext.to_lowercase().as_str(),
                "wav" | "mp3" | "m4a" | "aac" | "flac" | "ogg" | "opus"
            )
        })
        .unwrap_or(false)
}

fn find_executable(env_name: &str, candidates: &[&str]) -> Result<String, String> {
    if let Ok(path) = std::env::var(env_name) {
        let trimmed = path.trim();
        if !trimmed.is_empty() && Path::new(trimmed).exists() {
            return Ok(trimmed.to_string());
        }
    }

    let path_env = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_env) {
        for candidate in candidates {
            let path = dir.join(candidate);
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
        }
    }

    for dir in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/opt/local/bin",
    ] {
        for candidate in candidates {
            let path = Path::new(dir).join(candidate);
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
        }
    }

    Err(format!(
        "未找到本地转写程序，请设置 {} 或把 {} 放入 PATH",
        env_name,
        candidates.join("/")
    ))
}

fn emit_progress(
    app_handle: &AppHandle,
    task_id: Option<&str>,
    stage: &str,
    percentage: f64,
    message: &str,
    detail: Option<&str>,
) {
    let Some(task_id) = task_id.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    let progress = TranscriptionProgress {
        task_id: task_id.to_string(),
        stage: stage.to_string(),
        percentage: percentage.clamp(0.0, 100.0),
        message: message.to_string(),
        detail: detail.map(ToString::to_string),
    };
    let _ = app_handle.emit("transcription-progress", progress);
}

fn parse_ffmpeg_progress(line: &str, duration_seconds: Option<f64>) -> Option<f64> {
    let duration_seconds = duration_seconds.filter(|value| value.is_finite() && *value > 0.0)?;
    let value = line
        .strip_prefix("out_time_ms=")
        .or_else(|| line.strip_prefix("out_time_us="))
        .and_then(|value| value.trim().parse::<f64>().ok())
        .map(|value| value / 1_000_000.0)
        .or_else(|| {
            line.strip_prefix("out_time=")
                .and_then(|value| parse_timestamp_seconds(value.trim()))
        })?;
    Some((value / duration_seconds * 100.0).clamp(0.0, 100.0))
}

fn parse_timestamp_seconds(value: &str) -> Option<f64> {
    let mut parts = value.split(':').collect::<Vec<_>>();
    if parts.len() != 3 {
        return None;
    }
    let seconds = parts.pop()?.parse::<f64>().ok()?;
    let minutes = parts.pop()?.parse::<f64>().ok()?;
    let hours = parts.pop()?.parse::<f64>().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

fn parse_percent_progress(line: &str) -> Option<f64> {
    line.split(|c: char| c.is_whitespace() || matches!(c, '[' | ']' | '(' | ')' | ':' | '='))
        .filter_map(|part| {
            let value = part.trim().trim_end_matches('%');
            if part.trim().ends_with('%') {
                value.parse::<f64>().ok()
            } else {
                None
            }
        })
        .find(|value| value.is_finite() && *value >= 0.0 && *value <= 100.0)
}

fn keep_recent_chars(value: &mut String, max_chars: usize) {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return;
    }

    let keep_from_char = char_count - max_chars;
    if let Some((byte_index, _)) = value.char_indices().nth(keep_from_char) {
        value.drain(..byte_index);
    }
}

fn model_slug(model: TranscriptionModel) -> &'static str {
    match model {
        TranscriptionModel::WhisperCpp => "whisper-cpp",
        TranscriptionModel::FunAsr => "fun-asr",
    }
}
