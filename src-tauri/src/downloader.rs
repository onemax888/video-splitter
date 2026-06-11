use crate::mihomo::{start_mihomo_proxy, MihomoSession, ProxyOptions};
use chrono::Local;
use reqwest::header::CONTENT_LENGTH;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const ONCCG_API_ENDPOINT: &str = "https://api.onccg.com/api/";
const ONCCG_DEFAULT_TYPE: &str = "dsp";
const ONCCG_DEFAULT_KEY: &str = "aWvnXIfmhWBSJD3DGk";
const MEOWLOAD_API_ENDPOINT: &str = "https://api.meowload.net/openapi/extract/post";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const CANCELLED_MESSAGE: &str = "下载已取消";
static REMOTE_DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DownloadProvider {
    MeowloadCli,
    MeowloadApi,
    OnccgApi,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadQuality {
    Lowest,
    Best,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDownloadResult {
    pub provider: DownloadProvider,
    pub source_url: String,
    pub title: String,
    pub video_path: String,
    pub cover_path: Option<String>,
    pub output_dir: String,
    pub raw_dir: String,
    pub file_size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDownloadProgress {
    pub provider: DownloadProvider,
    pub stage: String,
    pub percentage: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub current_file: String,
}

#[derive(Debug, Clone)]
struct DownloadContext {
    source_url: String,
    title: String,
    output_dir: PathBuf,
    raw_dir: PathBuf,
}

#[derive(Debug, Clone)]
struct MediaChoice {
    url: String,
    audio_url: Option<String>,
    label: Option<String>,
    quality: Option<u32>,
    ext: String,
    audio_ext: Option<String>,
}

pub async fn download_remote_video(
    app_handle: &AppHandle,
    url: &str,
    provider: DownloadProvider,
    quality: DownloadQuality,
    download_dir: Option<String>,
    proxy_options: Option<ProxyOptions>,
) -> Result<RemoteDownloadResult, String> {
    let source_url = url.trim();
    if source_url.is_empty() {
        return Err("请输入视频链接".to_string());
    }
    REMOTE_DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst);

    match provider {
        DownloadProvider::MeowloadCli => {
            download_with_meowload_cli(app_handle, source_url, quality, download_dir.as_deref())
                .await
        }
        DownloadProvider::MeowloadApi => {
            download_with_meowload_api(
                app_handle,
                source_url,
                quality,
                download_dir.as_deref(),
                proxy_options.as_ref(),
            )
            .await
        }
        DownloadProvider::OnccgApi => {
            download_with_onccg(
                app_handle,
                source_url,
                quality,
                download_dir.as_deref(),
                proxy_options.as_ref(),
            )
            .await
        }
    }
}

pub fn cancel_remote_download() {
    REMOTE_DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
}

fn ensure_download_not_cancelled() -> Result<(), String> {
    if REMOTE_DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
        Err(CANCELLED_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

async fn download_with_meowload_cli(
    app_handle: &AppHandle,
    source_url: &str,
    quality: DownloadQuality,
    download_dir: Option<&str>,
) -> Result<RemoteDownloadResult, String> {
    emit_progress(
        app_handle,
        DownloadProvider::MeowloadCli,
        "checking",
        0.0,
        0,
        None,
        "meowload",
    );
    ensure_download_not_cancelled()?;

    let meowload = find_meowload().await?;
    ensure_download_not_cancelled()?;
    let output = Command::new(&meowload)
        .args(["info", source_url])
        .output()
        .await
        .map_err(|e| format!("运行 meowload info 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("meowload info 失败: {}", stderr.trim()));
    }
    ensure_download_not_cancelled()?;

    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("meowload 返回内容不是有效 JSON: {}", e))?;
    let title = parsed
        .get("text")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("downloaded-video");
    let ctx = create_download_context(source_url, title, "meowload-cli", download_dir)?;
    write_text(ctx.raw_dir.join("source_url.txt"), source_url).await?;
    write_text(
        ctx.raw_dir.join("meowload_info.json"),
        &pretty_json(&parsed)?,
    )
    .await?;

    let choice = choose_meowload_media(&parsed, quality)
        .ok_or_else(|| "meowload 未返回可下载的视频资源".to_string())?;
    ensure_download_not_cancelled()?;

    let video_path = download_meowload_choice(
        app_handle,
        DownloadProvider::MeowloadCli,
        &ctx,
        choice,
        None,
    )
    .await?;

    let cover_path = if let Some(preview_url) = parsed
        .get("medias")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find_map(|item| item.get("preview_url").and_then(Value::as_str))
        }) {
        ensure_download_not_cancelled()?;
        let cover_path = unique_path(
            ctx.output_dir
                .join(format!("{}_cover.jpg", safe_name(&ctx.title, "cover", 120))),
        );
        download_url_to_file(
            app_handle,
            DownloadProvider::MeowloadCli,
            preview_url,
            &cover_path,
            "cover",
            None,
        )
        .await
        .ok();
        cover_path
            .exists()
            .then(|| cover_path.to_string_lossy().to_string())
    } else {
        None
    };

    save_metadata(
        &ctx,
        DownloadProvider::MeowloadCli,
        &video_path,
        cover_path.as_deref(),
    )
    .await?;
    finish_result(ctx, DownloadProvider::MeowloadCli, video_path, cover_path)
}

async fn download_with_meowload_api(
    app_handle: &AppHandle,
    source_url: &str,
    quality: DownloadQuality,
    download_dir: Option<&str>,
    proxy_options: Option<&ProxyOptions>,
) -> Result<RemoteDownloadResult, String> {
    emit_progress(
        app_handle,
        DownloadProvider::MeowloadApi,
        "parsing",
        0.0,
        0,
        None,
        "MeowLoad API",
    );

    let api_key = std::env::var("MEOWLOAD_API_KEY")
        .or_else(|_| std::env::var("hhm_key"))
        .map_err(|_| "请先设置 MEOWLOAD_API_KEY 或 hhm_key 环境变量".to_string())?;
    ensure_download_not_cancelled()?;
    let proxy_session = start_api_proxy_if_enabled(
        app_handle,
        DownloadProvider::MeowloadApi,
        proxy_options,
    )
    .await?;
    let proxy_url = proxy_session.as_ref().map(|session| session.proxy_url());
    let client = http_client(proxy_url)?;
    ensure_download_not_cancelled()?;

    let response = client
        .post(MEOWLOAD_API_ENDPOINT)
        .header("x-api-key", api_key.trim())
        .header("accept-language", "zh")
        .json(&serde_json::json!({ "url": source_url }))
        .send()
        .await
        .map_err(|e| format!("MeowLoad API 请求失败: {}", e))?;
    ensure_download_not_cancelled()?;
    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|e| format!("读取 MeowLoad API 响应失败: {}", e))?;
    if !status.is_success() {
        return Err(format!("MeowLoad API HTTP {}: {}", status, raw));
    }

    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("MeowLoad API 返回内容不是有效 JSON: {}", e))?;
    let title = parsed
        .get("text")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("downloaded-video");
    let ctx = create_download_context(source_url, title, "meowload-api", download_dir)?;
    write_text(ctx.raw_dir.join("source_url.txt"), source_url).await?;
    write_text(ctx.raw_dir.join("raw_response.txt"), &raw).await?;
    write_text(
        ctx.raw_dir.join("extract_response.json"),
        &pretty_json(&parsed)?,
    )
    .await?;

    let choice = choose_meowload_media(&parsed, quality)
        .ok_or_else(|| "MeowLoad API 未返回可下载的视频资源".to_string())?;
    ensure_download_not_cancelled()?;
    let video_path = download_meowload_choice(
        app_handle,
        DownloadProvider::MeowloadApi,
        &ctx,
        choice,
        proxy_url,
    )
    .await?;

    save_metadata(
        &ctx,
        DownloadProvider::MeowloadApi,
        &video_path,
        None,
    )
    .await?;
    finish_result(ctx, DownloadProvider::MeowloadApi, video_path, None)
}

async fn download_with_onccg(
    app_handle: &AppHandle,
    source_url: &str,
    quality: DownloadQuality,
    download_dir: Option<&str>,
    proxy_options: Option<&ProxyOptions>,
) -> Result<RemoteDownloadResult, String> {
    emit_progress(
        app_handle,
        DownloadProvider::OnccgApi,
        "parsing",
        0.0,
        0,
        None,
        "ONCCG",
    );

    let api_key = std::env::var("ONCCG_KEY").unwrap_or_else(|_| ONCCG_DEFAULT_KEY.to_string());
    let api_type = std::env::var("ONCCG_TYPE").unwrap_or_else(|_| ONCCG_DEFAULT_TYPE.to_string());
    ensure_download_not_cancelled()?;
    let proxy_session = start_api_proxy_if_enabled(
        app_handle,
        DownloadProvider::OnccgApi,
        proxy_options,
    )
    .await?;
    let proxy_url = proxy_session.as_ref().map(|session| session.proxy_url());
    let client = http_client(proxy_url)?;
    ensure_download_not_cancelled()?;

    let response = client
        .get(ONCCG_API_ENDPOINT)
        .query(&[
            ("type", api_type.as_str()),
            ("key", api_key.as_str()),
            ("url", source_url),
        ])
        .send()
        .await
        .map_err(|e| format!("ONCCG 请求失败: {}", e))?;
    ensure_download_not_cancelled()?;
    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|e| format!("读取 ONCCG 响应失败: {}", e))?;
    if !status.is_success() {
        return Err(format!("ONCCG HTTP {}: {}", status, raw));
    }

    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("ONCCG 返回内容不是有效 JSON: {}", e))?;
    if let Some(code) = parsed.get("code").and_then(Value::as_str) {
        if code != "200" && code != "0" {
            let msg = parsed
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("未知错误");
            return Err(format!("ONCCG 解析失败: {}", msg));
        }
    } else if let Some(code) = parsed.get("code").and_then(Value::as_i64) {
        if code != 200 && code != 0 {
            let msg = parsed
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("未知错误");
            return Err(format!("ONCCG 解析失败: {}", msg));
        }
    }

    let title = parsed
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| {
            parsed
                .get("data")
                .and_then(|v| v.get("title"))
                .and_then(Value::as_str)
        })
        .unwrap_or("downloaded-video");
    let ctx = create_download_context(source_url, title, "onccg", download_dir)?;
    write_text(ctx.raw_dir.join("source_url.txt"), source_url).await?;
    write_text(ctx.raw_dir.join("raw_response.txt"), &raw).await?;
    write_text(ctx.raw_dir.join("response.json"), &pretty_json(&parsed)?).await?;

    let mut choices = Vec::new();
    collect_onccg_media(&parsed, source_url, "$", &mut choices);
    write_text(
        ctx.raw_dir.join("media_candidates.json"),
        &pretty_json(&media_choices_json(&choices))?,
    )
    .await?;

    let choice =
        choose_media(choices, quality).ok_or_else(|| "ONCCG 未返回可下载的视频资源".to_string())?;
    ensure_download_not_cancelled()?;
    let file_name = format!("{}.{}", safe_name(&ctx.title, "video", 120), choice.ext);
    let video_path = unique_path(ctx.output_dir.join(file_name));
    download_url_to_file(
        app_handle,
        DownloadProvider::OnccgApi,
        &choice.url,
        &video_path,
        "downloading",
        proxy_url,
    )
    .await?;

    let cover_url = parsed
        .get("img")
        .and_then(Value::as_str)
        .filter(|value| is_http_url(value));
    let cover_path = if let Some(cover_url) = cover_url {
        ensure_download_not_cancelled()?;
        let cover_path = unique_path(
            ctx.output_dir
                .join(format!("{}_cover.jpg", safe_name(&ctx.title, "cover", 120))),
        );
        download_url_to_file(
            app_handle,
            DownloadProvider::OnccgApi,
            cover_url,
            &cover_path,
            "cover",
            proxy_url,
        )
        .await
        .ok();
        cover_path
            .exists()
            .then(|| cover_path.to_string_lossy().to_string())
    } else {
        None
    };

    save_metadata(
        &ctx,
        DownloadProvider::OnccgApi,
        &video_path,
        cover_path.as_deref(),
    )
    .await?;
    finish_result(ctx, DownloadProvider::OnccgApi, video_path, cover_path)
}

async fn start_api_proxy_if_enabled(
    app_handle: &AppHandle,
    provider: DownloadProvider,
    proxy_options: Option<&ProxyOptions>,
) -> Result<Option<MihomoSession>, String> {
    if !proxy_options.map(|options| options.enabled).unwrap_or(false) {
        return Ok(None);
    }

    emit_progress(app_handle, provider, "proxy", 0.0, 0, None, "mihomo");
    let options = proxy_options.expect("checked proxy options");
    ensure_download_not_cancelled()?;
    start_mihomo_proxy(app_handle, options).await.map(Some)
}

fn preferred_media_url(item: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        item.get(*key)
            .and_then(Value::as_str)
            .filter(|value| is_http_url(value))
            .map(ToString::to_string)
    })
}

async fn find_meowload() -> Result<String, String> {
    if let Ok(path) = std::env::var("MEOWLOAD_PATH") {
        if !path.trim().is_empty() && Path::new(&path).exists() {
            return Ok(path);
        }
    }

    let candidates = [
        "meowload",
        "/usr/local/bin/meowload",
        "/opt/homebrew/bin/meowload",
        "/usr/bin/meowload",
    ];

    for candidate in candidates {
        let result = Command::new(candidate).arg("version").output().await;
        if let Ok(output) = result {
            if output.status.success() {
                return Ok(candidate.to_string());
            }
        }
    }

    Err("未找到 meowload，请确认它已安装并可在 PATH 中执行。".to_string())
}

fn choose_meowload_media(value: &Value, quality: DownloadQuality) -> Option<MediaChoice> {
    let medias = value.get("medias")?.as_array()?;
    let mut choices = Vec::new();
    for media in medias {
        if media.get("media_type").and_then(Value::as_str) != Some("video") {
            continue;
        }
        if let Some(resource_url) = preferred_media_url(
            media,
            &[
                "resource_proxy_url",
                "proxy_url",
                "video_proxy_url",
                "audio_proxy_url",
                "resource_url",
            ],
        ) {
            choices.push(MediaChoice {
                url: resource_url.clone(),
                audio_url: None,
                label: Some("resource".to_string()),
                quality: media
                    .get("quality")
                    .and_then(Value::as_u64)
                    .map(|v| v as u32)
                    .or(Some(360)),
                ext: infer_ext(
                    &resource_url,
                    media.get("video_ext").and_then(Value::as_str),
                    Some("mp4"),
                ),
                audio_ext: None,
            });
        }
        if let Some(formats) = media.get("formats").and_then(Value::as_array) {
            for format in formats {
                let Some(video_url) =
                    preferred_media_url(format, &["video_proxy_url", "proxy_url", "video_url"])
                else {
                    continue;
                };
                let is_separate = format.get("separate").and_then(Value::as_i64).unwrap_or(0) == 1;
                let audio_url = is_separate
                    .then(|| preferred_media_url(format, &["audio_proxy_url", "audio_url"]))
                    .flatten();
                let label = format
                    .get("quality_note")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                choices.push(MediaChoice {
                    url: video_url.clone(),
                    audio_url,
                    label,
                    quality: format
                        .get("quality")
                        .and_then(Value::as_u64)
                        .map(|v| v as u32),
                    ext: infer_ext(
                        &video_url,
                        format.get("video_ext").and_then(Value::as_str),
                        Some("mp4"),
                    ),
                    audio_ext: format
                        .get("audio_ext")
                        .and_then(Value::as_str)
                        .map(|value| normalize_ext(value.trim_start_matches('.'))),
                });
            }
        }
    }
    choose_media(choices, quality)
}

fn collect_onccg_media(value: &Value, source_url: &str, path: &str, out: &mut Vec<MediaChoice>) {
    match value {
        Value::Object(map) => {
            let mut labels = Vec::new();
            for key in [
                "type",
                "quality",
                "quality_note",
                "name",
                "format",
                "label",
                "title",
            ] {
                if let Some(text) = map.get(key).and_then(Value::as_str) {
                    labels.push(text.to_string());
                }
            }

            for (key, child) in map {
                let child_path = format!("{}.{}", path, key);
                if let Some(url) = child.as_str().filter(|s| is_http_url(s)) {
                    if should_skip_media_url(url, source_url) {
                        continue;
                    }
                    let lower_key = key.to_lowercase();
                    let lower_url = url.to_lowercase();
                    let is_video = lower_key.contains("video")
                        || lower_key.contains("play")
                        || lower_key.contains("download")
                        || lower_url.contains(".mp4")
                        || lower_url.contains(".m3u8")
                        || lower_url.contains("mime=video");
                    let is_audio = lower_key.contains("audio") || lower_url.contains("mime=audio");
                    let is_image = lower_key.contains("img")
                        || lower_key.contains("cover")
                        || lower_key.contains("pic")
                        || lower_url.contains(".jpg")
                        || lower_url.contains(".png")
                        || lower_url.contains(".webp");
                    if is_video && !is_audio && !is_image {
                        let label = labels.first().cloned();
                        let quality = labels.iter().find_map(|label| parse_quality(label));
                        out.push(MediaChoice {
                            url: url.to_string(),
                            audio_url: None,
                            label,
                            quality,
                            ext: infer_ext(url, None, Some("mp4")),
                            audio_ext: None,
                        });
                    }
                }
                collect_onccg_media(child, source_url, &child_path, out);
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                collect_onccg_media(item, source_url, &format!("{}[{}]", path, index), out);
            }
        }
        _ => {}
    }
}

fn choose_media(mut choices: Vec<MediaChoice>, quality: DownloadQuality) -> Option<MediaChoice> {
    let mut seen = HashSet::new();
    choices.retain(|choice| seen.insert(choice.url.clone()));
    if choices.is_empty() {
        return None;
    }
    let with_audio: Vec<MediaChoice> = choices
        .iter()
        .filter(|choice| choice.label.as_deref().unwrap_or("").contains("有声"))
        .cloned()
        .collect();
    if !with_audio.is_empty() {
        choices = with_audio;
    }
    choices.sort_by_key(|choice| choice.quality.unwrap_or(u32::MAX));
    match quality {
        DownloadQuality::Lowest => choices.into_iter().next(),
        DownloadQuality::Best => choices.into_iter().last(),
    }
}

async fn download_meowload_choice(
    app_handle: &AppHandle,
    provider: DownloadProvider,
    ctx: &DownloadContext,
    choice: MediaChoice,
    proxy_url: Option<&str>,
) -> Result<PathBuf, String> {
    let safe_title = safe_name(&ctx.title, "video", 120);
    ensure_download_not_cancelled()?;
    if let Some(audio_url) = choice.audio_url.as_deref() {
        let video_path = unique_path(
            ctx.output_dir
                .join(format!("{}_video.{}", safe_title, choice.ext)),
        );
        download_url_to_file(
            app_handle,
            provider,
            &choice.url,
            &video_path,
            "downloading",
            proxy_url,
        )
        .await?;
        ensure_download_not_cancelled()?;

        let audio_ext = choice.audio_ext.as_deref().unwrap_or("m4a");
        let audio_path = unique_path(
            ctx.output_dir
                .join(format!("{}_audio.{}", safe_title, audio_ext)),
        );
        download_url_to_file(
            app_handle,
            provider,
            audio_url,
            &audio_path,
            "downloading",
            proxy_url,
        )
        .await?;
        ensure_download_not_cancelled()?;

        let merged_path = unique_path(ctx.output_dir.join(format!("{}.mp4", safe_title)));
        merge_video_audio(app_handle, &video_path, &audio_path, &merged_path).await?;
        Ok(merged_path)
    } else {
        let file_name = format!("{}.{}", safe_title, choice.ext);
        let video_path = unique_path(ctx.output_dir.join(file_name));
        download_url_to_file(
            app_handle,
            provider,
            &choice.url,
            &video_path,
            "downloading",
            proxy_url,
        )
        .await?;
        Ok(video_path)
    }
}

async fn merge_video_audio(
    app_handle: &AppHandle,
    video_path: &Path,
    audio_path: &Path,
    output_path: &Path,
) -> Result<(), String> {
    ensure_download_not_cancelled()?;
    let video_arg = video_path.to_string_lossy().to_string();
    let audio_arg = audio_path.to_string_lossy().to_string();
    let output_arg = output_path.to_string_lossy().to_string();
    let output = app_handle
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("FFmpeg sidecar 不可用，无法合并音视频: {}", e))?
        .args([
            "-y",
            "-i",
            video_arg.as_str(),
            "-i",
            audio_arg.as_str(),
            "-c",
            "copy",
            output_arg.as_str(),
        ])
        .output()
        .await
        .map_err(|e| format!("FFmpeg 合并音视频失败: {}", e))?;

    if output.status.success() {
        ensure_download_not_cancelled()?;
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("FFmpeg 合并音视频失败: {}", stderr.trim()))
    }
}

async fn download_url_to_file(
    app_handle: &AppHandle,
    provider: DownloadProvider,
    url: &str,
    output_path: &Path,
    stage: &str,
    proxy_url: Option<&str>,
) -> Result<(), String> {
    ensure_download_not_cancelled()?;
    let client = http_client(proxy_url)?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {}", e))?;
    ensure_download_not_cancelled()?;
    if !response.status().is_success() {
        return Err(format!("下载失败 HTTP {}", response.status()));
    }

    let total = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .or_else(|| response.content_length());
    let display = output_path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("video")
        .to_string();
    let mut file = tokio::fs::File::create(output_path)
        .await
        .map_err(|e| format!("创建文件失败: {}", e))?;
    let mut downloaded = 0_u64;

    let download_result = loop {
        if let Err(err) = ensure_download_not_cancelled() {
            break Err(err);
        }
        let chunk = response
            .chunk()
            .await
            .map_err(|e| format!("读取下载数据失败: {}", e))?;
        let Some(chunk) = chunk else {
            break Ok(());
        };
        if let Err(err) = ensure_download_not_cancelled() {
            break Err(err);
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入下载文件失败: {}", e))?;
        downloaded += chunk.len() as u64;
        let percentage = total
            .filter(|value| *value > 0)
            .map(|value| downloaded as f64 / value as f64 * 100.0)
            .unwrap_or(0.0);
        emit_progress(
            app_handle, provider, stage, percentage, downloaded, total, &display,
        );
    };

    if let Err(err) = download_result {
        let _ = file.flush().await;
        let _ = tokio::fs::remove_file(output_path).await;
        return Err(err);
    }

    file.flush()
        .await
        .map_err(|e| format!("保存下载文件失败: {}", e))?;
    if let Err(err) = ensure_download_not_cancelled() {
        let _ = tokio::fs::remove_file(output_path).await;
        return Err(err);
    }
    emit_progress(
        app_handle, provider, stage, 100.0, downloaded, total, &display,
    );
    Ok(())
}

fn http_client(proxy_url: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().user_agent(USER_AGENT);
    if let Some(proxy_url) = proxy_url {
        let proxy = reqwest::Proxy::all(proxy_url).map_err(|e| format!("代理配置无效: {}", e))?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))
}

fn create_download_context(
    source_url: &str,
    title: &str,
    provider: &str,
    download_dir: Option<&str>,
) -> Result<DownloadContext, String> {
    let base = downloads_base_dir(download_dir)?;
    let timestamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let safe_title = safe_name(title, "downloaded-video", 80);
    let output_dir = unique_path(base.join(format!("{}-{}-{}", timestamp, provider, safe_title)));
    std::fs::create_dir_all(&output_dir).map_err(|e| format!("创建下载目录失败: {}", e))?;
    let raw_dir = output_dir.join("_raw");
    std::fs::create_dir_all(&raw_dir).map_err(|e| format!("创建响应目录失败: {}", e))?;

    Ok(DownloadContext {
        source_url: source_url.to_string(),
        title: title.to_string(),
        output_dir,
        raw_dir,
    })
}

fn downloads_base_dir(download_dir: Option<&str>) -> Result<PathBuf, String> {
    let base = if let Some(download_dir) = download_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        PathBuf::from(download_dir)
    } else {
        let home = std::env::var("HOME").map_err(|_| "无法定位 HOME 目录".to_string())?;
        Path::new(&home)
            .join("Movies")
            .join("VideoClippingDownloads")
    };
    std::fs::create_dir_all(&base).map_err(|e| format!("创建媒体库目录失败: {}", e))?;
    Ok(base)
}

async fn save_metadata(
    ctx: &DownloadContext,
    provider: DownloadProvider,
    video_path: &Path,
    cover_path: Option<&str>,
) -> Result<(), String> {
    let metadata = serde_json::json!({
        "provider": provider,
        "sourceUrl": ctx.source_url,
        "title": ctx.title,
        "videoPath": video_path,
        "coverPath": cover_path,
        "createdAt": Local::now().to_rfc3339(),
    });
    write_text(
        ctx.output_dir.join("metadata.json"),
        &pretty_json(&metadata)?,
    )
    .await
}

fn finish_result(
    ctx: DownloadContext,
    provider: DownloadProvider,
    video_path: PathBuf,
    cover_path: Option<String>,
) -> Result<RemoteDownloadResult, String> {
    let file_size = std::fs::metadata(&video_path).map(|m| m.len()).unwrap_or(0);
    Ok(RemoteDownloadResult {
        provider,
        source_url: ctx.source_url,
        title: ctx.title,
        video_path: video_path.to_string_lossy().to_string(),
        cover_path,
        output_dir: ctx.output_dir.to_string_lossy().to_string(),
        raw_dir: ctx.raw_dir.to_string_lossy().to_string(),
        file_size,
    })
}

fn emit_progress(
    app_handle: &AppHandle,
    provider: DownloadProvider,
    stage: &str,
    percentage: f64,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    current_file: &str,
) {
    let _ = app_handle.emit(
        "remote-download-progress",
        RemoteDownloadProgress {
            provider,
            stage: stage.to_string(),
            percentage,
            downloaded_bytes,
            total_bytes,
            current_file: current_file.to_string(),
        },
    );
}

fn infer_ext(url: &str, explicit_ext: Option<&str>, fallback: Option<&str>) -> String {
    if let Some(ext) = explicit_ext {
        let ext = ext.trim().trim_start_matches('.').to_lowercase();
        if !ext.is_empty() {
            return normalize_ext(&ext);
        }
    }

    if let Ok(parsed) = reqwest::Url::parse(url) {
        if let Some(segment) = parsed.path_segments().and_then(|mut s| s.next_back()) {
            if let Some((_, ext)) = segment.rsplit_once('.') {
                let ext = ext.to_lowercase();
                if ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return normalize_ext(&ext);
                }
            }
        }
        if let Some(mime) = parsed
            .query_pairs()
            .find_map(|(key, value)| (key == "mime").then(|| value.to_string()))
        {
            if mime.contains("webm") {
                return "webm".to_string();
            }
            if mime.contains("mp4") {
                return "mp4".to_string();
            }
        }
    }

    fallback.unwrap_or("mp4").to_string()
}

fn normalize_ext(ext: &str) -> String {
    match ext {
        "weba" => "webm".to_string(),
        "jpeg" => "jpg".to_string(),
        value => value.to_string(),
    }
}

fn parse_quality(value: &str) -> Option<u32> {
    let mut digits = String::new();
    for ch in value.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else if !digits.is_empty() {
            break;
        }
    }
    digits.parse::<u32>().ok().filter(|v| *v > 0)
}

fn safe_name(value: &str, fallback: &str, limit: usize) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        let allowed = ch.is_ascii_alphanumeric()
            || matches!(ch, '.' | '_' | '-')
            || ('\u{4e00}'..='\u{9fff}').contains(&ch);
        if allowed {
            out.push(ch);
        } else if !out.ends_with('_') {
            out.push('_');
        }
        if out.chars().count() >= limit {
            break;
        }
    }
    let trimmed = out.trim_matches(['.', '_', '-']).to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let parent = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
    for index in 1..10000 {
        let name = if ext.is_empty() {
            format!("{}_{}", stem, index)
        } else {
            format!("{}_{}.{}", stem, index, ext)
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

fn is_http_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn should_skip_media_url(url: &str, source_url: &str) -> bool {
    url == source_url
        || url.contains("youtube.com/watch")
        || url.contains("youtu.be/")
        || url.contains("douyin.com/")
        || url.contains("bilibili.com/video/")
}

fn media_choices_json(choices: &[MediaChoice]) -> Value {
    Value::Array(
        choices
            .iter()
            .map(|choice| {
                serde_json::json!({
                    "url": choice.url,
                    "audioUrl": choice.audio_url,
                    "label": choice.label,
                    "quality": choice.quality,
                    "ext": choice.ext,
                    "audioExt": choice.audio_ext,
                })
            })
            .collect(),
    )
}

fn pretty_json(value: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|e| format!("JSON 序列化失败: {}", e))
}

async fn write_text(path: PathBuf, text: &str) -> Result<(), String> {
    tokio::fs::write(path, text)
        .await
        .map_err(|e| format!("写入文件失败: {}", e))
}
