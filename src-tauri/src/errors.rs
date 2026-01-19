use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
}

impl AppError {
    pub fn from_message(message: impl Into<String>) -> Self {
        let msg = message.into();
        let code = map_error_code(&msg).to_string();
        AppError {
            code,
            message: msg.clone(),
            detail: Some(msg),
        }
    }
}

fn map_error_code(message: &str) -> &'static str {
    let lower = message.to_lowercase();

    if lower.contains("ffmpeg") {
        if lower.contains("not found") || lower.contains("locate ffmpeg") || lower.contains("ffmpeg sidecar") {
            return "FFMPEG_NOT_FOUND";
        }
        return "FFMPEG_FAILED";
    }

    if lower.contains("ffprobe") || (lower.contains("duration") && lower.contains("parse")) {
        return "FFPROBE_FAILED";
    }

    if lower.contains("hls") {
        return "HLS_FAILED";
    }

    if message.contains("片段") || message.contains("切分范围") || lower.contains("segment") {
        return "INVALID_RANGE";
    }

    if message.contains("输出目录") || lower.contains("output dir") || lower.contains("output directory") {
        return "OUTPUT_DIR_FAILED";
    }

    if message.contains("片头") || message.contains("片尾") || lower.contains("append") {
        return "APPEND_INVALID";
    }

    "UNKNOWN"
}
