mod commands;
mod downloader;
mod errors;
pub mod ffmpeg;
mod mihomo;

use commands::{
    allow_asset_path, check_ffmpeg_command, download_remote_video_command, get_video_info,
    import_proxy_config_file_command, import_proxy_config_url_command, prepare_hls_source_command,
    measure_proxy_node_delays_command, select_directory, split_video_by_ranges_command,
    split_video_command,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            allow_asset_path,
            check_ffmpeg_command,
            download_remote_video_command,
            get_video_info,
            import_proxy_config_file_command,
            import_proxy_config_url_command,
            measure_proxy_node_delays_command,
            prepare_hls_source_command,
            split_video_command,
            split_video_by_ranges_command,
            select_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
