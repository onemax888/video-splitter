mod batch;
mod process;
mod commands;
mod errors;
pub mod ffmpeg;

use commands::{allow_asset_path, check_ffmpeg_command, get_video_info, prepare_hls_source_command, select_directory, split_video_command, split_video_by_ranges_command};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(batch::BatchState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            batch::batch_split,
            batch::stop_batch_split,
            allow_asset_path,
            check_ffmpeg_command,
            get_video_info,
            prepare_hls_source_command,
            split_video_command,
            split_video_by_ranges_command,
            select_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
