use crate::ffmpeg::{self, AppendKind, AppendSource, IntervalSplitMode};
use crate::process::ProcessControl;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct BatchState(Mutex<Option<Arc<ProcessControl>>>);

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum OutputLayout {
    PerVideo,
    Together,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRequest {
    job_id: String,
    paths: Vec<String>,
    output_dir: String,
    layout: OutputLayout,
    segment_duration: u32,
    interval_mode: IntervalSplitMode,
    intro: Option<AppendSource>,
    outro: Option<AppendSource>,
}

#[derive(Clone, Serialize)]
pub struct BatchItem {
    pub input_path: String,
    pub status: String,
    pub output_files: Vec<String>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct BatchResult {
    pub job_id: String,
    pub output_dir: String,
    pub items: Vec<BatchItem>,
    pub current_index: Option<usize>,
    pub status: String,
    pub error: Option<String>,
    pub total_elapsed_ms: u64,
}

#[tauri::command]
pub fn stop_batch_split(job_id: String, state: State<'_, BatchState>) -> Result<(), String> {
    let active = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(control) = active.as_ref().filter(|c| c.job_id == job_id) {
        control.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn batch_split(
    app: AppHandle,
    request: BatchRequest,
    state: State<'_, BatchState>,
) -> Result<BatchResult, String> {
    validate_request(&request)?;
    let control = Arc::new(ProcessControl::new(request.job_id.clone()));
    {
        let mut active = state.0.lock().map_err(|e| e.to_string())?;
        if active.is_some() {
            return Err("已有批量任务正在运行".into());
        }
        *active = Some(control.clone());
    }
    let result = execute_batch(&app, request, &control).await;
    *state.0.lock().map_err(|e| e.to_string())? = None;
    result
}

fn validate_request(request: &BatchRequest) -> Result<(), String> {
    if request.job_id.is_empty() || request.paths.is_empty() || request.segment_duration == 0 {
        return Err("请选择视频并设置有效的切分时长".into());
    }
    if !Path::new(&request.output_dir).is_dir() {
        return Err("输出目录不存在".into());
    }
    for source in [&request.intro, &request.outro].into_iter().flatten() {
        if !Path::new(&source.path).is_file() {
            return Err("片头或片尾文件不存在".into());
        }
        if matches!(source.kind, AppendKind::Image)
            && !source
                .duration_seconds
                .is_some_and(|d| d.is_finite() && d > 0.0)
        {
            return Err("图片片头或片尾需要有效时长".into());
        }
    }
    Ok(())
}

fn create_batch_dir(parent: &Path) -> Result<PathBuf, String> {
    let name = Local::now().format("%Y%m%d_%H%M%S").to_string();
    for suffix in 0..1000 {
        let dir = parent.join(if suffix == 0 {
            name.clone()
        } else {
            format!("{name}_{suffix:02}")
        });
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("无法创建输出目录: {e}")),
        }
    }
    Err("无法创建唯一批次目录".into())
}

fn source_folder(index: usize, input: &str) -> String {
    let stem = Path::new(input)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let clean = ffmpeg::sanitize_segment_label(stem).unwrap_or_else(|| "video".into());
    let short: String = clean.chars().take(60).collect();
    format!("{:03}_{}", index + 1, short.trim_end_matches(['.', ' ']))
}

fn csv_cell(value: &str) -> String {
    let safe = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    format!("\"{}\"", safe.replace('"', "\"\""))
}

fn write_manifest(root: &Path, items: &[BatchItem]) -> Result<(), String> {
    let pending = root.join(".manifest.tmp");
    let mut file = File::create(&pending).map_err(|e| e.to_string())?;
    file.write_all("\u{feff}输出文件,原视频,视频序号,片段序号,状态,错误\r\n".as_bytes())
        .map_err(|e| e.to_string())?;
    for (index, item) in items.iter().enumerate() {
        let rows: Vec<Option<&String>> = if item.output_files.is_empty() {
            vec![None]
        } else {
            item.output_files.iter().map(Some).collect()
        };
        for (segment, output) in rows.into_iter().enumerate() {
            let relative = output
                .and_then(|s| Path::new(s).strip_prefix(root).ok())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let fields = [
                relative,
                item.input_path.clone(),
                (index + 1).to_string(),
                if output.is_some() {
                    (segment + 1).to_string()
                } else {
                    String::new()
                },
                item.status.clone(),
                item.error.clone().unwrap_or_default(),
            ];
            writeln!(
                file,
                "{}\r",
                fields
                    .iter()
                    .map(|s| csv_cell(s))
                    .collect::<Vec<_>>()
                    .join(",")
            )
            .map_err(|e| e.to_string())?;
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    let target = root.join("切分清单.csv");
    fs::rename(&pending, &target).map_err(|e| e.to_string())
}

// Publish only a complete video's nonempty files; partial moves are rolled back.
fn publish_video(
    root: &Path,
    files: &[String],
    input: &str,
    video_index: usize,
    start: usize,
    layout: OutputLayout,
) -> Result<Vec<String>, String> {
    if files.is_empty() {
        return Err("未生成有效片段".into());
    }
    for file in files {
        let metadata = fs::metadata(file).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err("生成了空片段".into());
        }
    }
    let target = if layout == OutputLayout::PerVideo {
        root.join(source_folder(video_index, input))
    } else {
        root.to_owned()
    };
    if layout == OutputLayout::PerVideo {
        fs::create_dir(&target).map_err(|e| e.to_string())?;
    }
    let width = 6.max((start + files.len() - 1).to_string().len());
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (index, source) in files.iter().enumerate() {
        let extension = Path::new(source)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("mp4");
        let dest = target.join(format!("{:0width$}.{extension}", start + index));
        let attempt = (|| {
            // Reserve our name without clobbering files, including on Unix.
            let reservation = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&dest)?;
            drop(reservation);
            if let Err(e) = fs::rename(source, &dest) {
                let _ = fs::remove_file(&dest);
                return Err(e);
            }
            Ok::<(), std::io::Error>(())
        })();
        if let Err(error) = attempt {
            for (original, published) in moved.iter().rev() {
                let _ = fs::rename(published, original);
            }
            if layout == OutputLayout::PerVideo {
                let _ = fs::remove_dir(&target);
            }
            return Err(format!("写入输出文件失败: {error}"));
        }
        moved.push((PathBuf::from(source), dest));
    }
    Ok(moved
        .into_iter()
        .map(|(_, p)| p.to_string_lossy().into_owned())
        .collect())
}

fn emit(app: &AppHandle, result: &mut BatchResult, started: Instant) {
    result.total_elapsed_ms = started.elapsed().as_millis() as u64;
    let _ = app.emit("batch-progress", &*result);
}

fn fatal_ffmpeg_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    [
        "no space left",
        "disk full",
        "not enough space",
        "disk quota",
        "read-only file system",
    ]
    .iter()
    .any(|s| error.contains(s))
}

async fn execute_batch(
    app: &AppHandle,
    request: BatchRequest,
    control: &ProcessControl,
) -> Result<BatchResult, String> {
    let started = Instant::now();
    let root = create_batch_dir(Path::new(&request.output_dir))?;
    let mut seen = HashSet::new();
    let paths: Vec<String> = request
        .paths
        .iter()
        .filter(|path| seen.insert(fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))))
        .cloned()
        .collect();
    let mut result = BatchResult {
        job_id: request.job_id.clone(),
        output_dir: root.to_string_lossy().into_owned(),
        items: paths
            .iter()
            .map(|path| BatchItem {
                input_path: path.clone(),
                status: "pending".into(),
                output_files: vec![],
                error: None,
            })
            .collect(),
        current_index: None,
        status: "running".into(),
        error: None,
        total_elapsed_ms: 0,
    };
    write_manifest(&root, &result.items)?;
    let mut next = 1;
    for (index, input) in paths.iter().enumerate() {
        if control.is_cancelled() {
            break;
        }
        result.current_index = Some(index);
        result.items[index].status = "running".into();
        emit(app, &mut result, started);
        let stage = root.join(".processing");
        if let Err(e) = fs::create_dir(&stage) {
            result.error = Some(format!("无法创建临时输出目录: {e}"));
            result.items[index].status = "failed".into();
            result.items[index].error = result.error.clone();
            break;
        }
        let dir = stage.to_string_lossy();
        let split = if request.intro.is_some() || request.outro.is_some() {
            ffmpeg::split_video_with_append_into(
                app,
                input,
                &dir,
                request.segment_duration,
                None,
                request.intro.clone(),
                request.outro.clone(),
                Some(control),
            )
            .await
        } else {
            ffmpeg::split_video_into(
                app,
                input,
                &dir,
                request.segment_duration,
                request.interval_mode,
                Some(control),
            )
            .await
        };
        let mut fatal = false;
        if control.is_cancelled() {
            result.items[index].status = "cancelled".into();
        } else {
            match split {
                Ok(split) => {
                    let start = if request.layout == OutputLayout::Together {
                        next
                    } else {
                        1
                    };
                    match publish_video(
                        &root,
                        &split.output_files,
                        input,
                        index,
                        start,
                        request.layout,
                    ) {
                        Ok(files) => {
                            next += files.len();
                            result.items[index].output_files = files;
                            result.items[index].status = "success".into();
                        }
                        Err(e) => {
                            fatal = true;
                            result.items[index].status = "failed".into();
                            result.items[index].error = Some(e);
                        }
                    }
                }
                Err(e) => {
                    fatal = fatal_ffmpeg_error(&e);
                    result.items[index].status = "failed".into();
                    result.items[index].error = Some(e);
                }
            }
        }
        if let Err(e) = fs::remove_dir_all(&stage) {
            result.error = Some(format!("临时文件清理失败: {e}"));
            fatal = true;
        }
        if let Err(e) = write_manifest(&root, &result.items) {
            result.error = Some(format!("保存切分清单失败: {e}"));
            fatal = true;
        }
        emit(app, &mut result, started);
        if fatal {
            if result.error.is_none() {
                result.error = result.items[index].error.clone();
            }
            break;
        }
    }
    for item in &mut result.items {
        if item.status == "pending" {
            item.status = if control.is_cancelled() {
                "cancelled"
            } else {
                "skipped"
            }
            .into();
        }
    }
    result.current_index = None;
    result.status = if result.error.is_some() {
        "failed"
    } else if control.is_cancelled() {
        "cancelled"
    } else if result.items.iter().all(|i| i.status == "failed") {
        "failed"
    } else if result.items.iter().any(|i| i.status == "failed") {
        "partial"
    } else {
        "success"
    }
    .into();
    if let Err(e) = widen_global_numbers(&mut result, request.layout)
        .and_then(|_| write_manifest(&root, &result.items))
    {
        result.status = "failed".into();
        result.error = Some(e);
    }
    emit(app, &mut result, started);
    Ok(result)
}

// Keep lexical ordering correct even if a batch exceeds the default six digits.
fn widen_global_numbers(result: &mut BatchResult, layout: OutputLayout) -> Result<(), String> {
    if layout != OutputLayout::Together {
        return Ok(());
    }
    let count: usize = result.items.iter().map(|i| i.output_files.len()).sum();
    let width = 6.max(count.to_string().len());
    if width == 6 {
        return Ok(());
    }
    for file in result.items.iter_mut().flat_map(|i| &mut i.output_files) {
        let path = Path::new(file);
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("无效的输出文件名")?;
        if stem.len() >= width {
            continue;
        }
        let name = format!(
            "{:0>width$}.{}",
            stem,
            path.extension().and_then(|s| s.to_str()).unwrap_or("mp4")
        );
        let target = path.with_file_name(name);
        if target.exists() {
            return Err("重新编号时发现同名文件".into());
        }
        fs::rename(path, &target).map_err(|e| e.to_string())?;
        *file = target.to_string_lossy().into_owned();
    }
    Ok(())
}

#[cfg(test)]
#[path = "batch_tests.rs"]
mod tests;
