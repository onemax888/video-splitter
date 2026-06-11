use crate::downloader::{
    cancel_remote_download, download_remote_video, DownloadProvider, DownloadQuality,
    RemoteDownloadResult,
};
use crate::errors::AppError;
use crate::ffmpeg::{
    check_ffmpeg, format_duration, get_video_duration, prepare_hls_source, split_video,
    split_video_by_ranges, split_video_with_append, AppendSource, FFmpegStatus, PreviewSource,
    SeekMode, SplitResult, TimeRange, VideoInfo,
};
use crate::mihomo::{
    import_proxy_config_from_file, import_proxy_config_from_url, measure_proxy_node_delays,
    ProxyConfigInfo, ProxyNodeDelay, ProxyOptions,
};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn check_ffmpeg_command(app_handle: AppHandle) -> FFmpegStatus {
    check_ffmpeg(&app_handle).await
}

#[tauri::command]
pub async fn get_video_info(app_handle: AppHandle, path: String) -> Result<VideoInfo, AppError> {
    let duration = get_video_duration(&app_handle, &path)
        .await
        .map_err(AppError::from_message)?;
    let duration_formatted = format_duration(duration);

    let file_path = std::path::Path::new(&path);
    let filename = file_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    Ok(VideoInfo {
        path,
        duration,
        duration_formatted,
        filename,
        file_size,
    })
}

#[tauri::command]
pub async fn download_remote_video_command(
    app_handle: AppHandle,
    url: String,
    provider: DownloadProvider,
    quality: DownloadQuality,
    download_dir: Option<String>,
    proxy_options: Option<ProxyOptions>,
) -> Result<RemoteDownloadResult, AppError> {
    download_remote_video(
        &app_handle,
        &url,
        provider,
        quality,
        download_dir,
        proxy_options,
    )
    .await
    .map_err(AppError::from_message)
}

#[tauri::command]
pub fn cancel_remote_download_command() -> Result<(), AppError> {
    cancel_remote_download();
    Ok(())
}

#[tauri::command]
pub async fn import_proxy_config_url_command(url: String) -> Result<ProxyConfigInfo, AppError> {
    import_proxy_config_from_url(&url)
        .await
        .map_err(AppError::from_message)
}

#[tauri::command]
pub async fn import_proxy_config_file_command(path: String) -> Result<ProxyConfigInfo, AppError> {
    import_proxy_config_from_file(&path)
        .await
        .map_err(AppError::from_message)
}

#[tauri::command]
pub async fn measure_proxy_node_delays_command(
    app_handle: AppHandle,
    config_path: String,
) -> Result<Vec<ProxyNodeDelay>, AppError> {
    measure_proxy_node_delays(&app_handle, &config_path)
        .await
        .map_err(AppError::from_message)
}

#[tauri::command]
pub async fn split_video_command(
    app_handle: AppHandle,
    input_path: String,
    output_dir: String,
    segment_duration: u32,
    intro: Option<AppendSource>,
    outro: Option<AppendSource>,
) -> Result<SplitResult, AppError> {
    if intro.is_none() && outro.is_none() {
        split_video(&app_handle, &input_path, &output_dir, segment_duration)
            .await
            .map_err(AppError::from_message)
    } else {
        split_video_with_append(
            &app_handle,
            &input_path,
            &output_dir,
            segment_duration,
            None,
            intro,
            outro,
        )
        .await
        .map_err(AppError::from_message)
    }
}

#[tauri::command]
pub async fn split_video_by_ranges_command(
    app_handle: AppHandle,
    input_path: String,
    output_dir: String,
    ranges: Vec<TimeRange>,
    seek_mode: SeekMode,
    fast_copy_threshold_seconds: Option<u32>,
    intro: Option<AppendSource>,
    outro: Option<AppendSource>,
) -> Result<SplitResult, AppError> {
    if intro.is_none() && outro.is_none() {
        split_video_by_ranges(
            &app_handle,
            &input_path,
            &output_dir,
            ranges,
            seek_mode,
            fast_copy_threshold_seconds,
        )
        .await
        .map_err(AppError::from_message)
    } else {
        split_video_with_append(
            &app_handle,
            &input_path,
            &output_dir,
            0,
            Some(ranges),
            intro,
            outro,
        )
        .await
        .map_err(AppError::from_message)
    }
}

#[tauri::command]
pub async fn prepare_hls_source_command(
    app_handle: AppHandle,
    input_path: String,
    min_size_bytes: u64,
    segment_seconds: u64,
    start_seconds: Option<f64>,
    window_seconds: Option<u64>,
) -> Result<PreviewSource, AppError> {
    prepare_hls_source(
        &app_handle,
        &input_path,
        min_size_bytes,
        segment_seconds,
        start_seconds,
        window_seconds,
    )
    .await
    .map_err(AppError::from_message)
}

/// Allow a user-selected file or directory for the asset protocol.
#[tauri::command]
pub async fn allow_asset_path(
    app_handle: AppHandle,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let scope = app_handle.asset_protocol_scope();
    if is_dir {
        scope.allow_directory(path, true).map_err(|e| e.to_string())
    } else {
        scope.allow_file(path).map_err(|e| e.to_string())
    }
}

/// Select output directory (uses native dialog)
#[tauri::command]
pub async fn select_directory() -> Result<Option<String>, String> {
    // This will be handled by tauri-plugin-dialog on the frontend
    Ok(None)
}
