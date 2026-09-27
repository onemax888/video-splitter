use std::sync::atomic::{AtomicBool, Ordering};
use tauri_plugin_shell::process::{Command, CommandEvent};
use tokio::sync::Notify;

pub struct ProcessControl {
    pub job_id: String,
    cancelled: AtomicBool,
    wake: Notify,
}

impl ProcessControl {
    pub fn new(job_id: String) -> Self {
        Self {
            job_id,
            cancelled: AtomicBool::new(false),
            wake: Notify::new(),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

// Drain output while running, and wait for termination before removing partial files.
pub async fn run_command(command: Command, control: Option<&ProcessControl>) -> Result<(), String> {
    if control.is_some_and(ProcessControl::is_cancelled) {
        return Err("任务已停止".into());
    }
    let (mut events, child) = command
        .spawn()
        .map_err(|e| format!("FFmpeg 启动失败: {e}"))?;
    let mut child = Some(child);
    let mut stderr = Vec::new();
    let mut process_error = None;
    loop {
        if control.is_some_and(ProcessControl::is_cancelled) {
            if let Some(child) = child.take() {
                // A process may have exited just before cancellation; still drain its events.
                let _ = child.kill();
            }
        }
        let event = tokio::select! {
            event = events.recv() => event,
            _ = async {
                match control {
                    Some(control) => control.wake.notified().await,
                    None => std::future::pending::<()>().await,
                }
            } => continue,
        };
        match event {
            Some(CommandEvent::Stderr(bytes)) => {
                stderr.extend(bytes);
                stderr.push(b'\n');
                if stderr.len() > 65536 {
                    stderr.drain(..stderr.len() - 65536);
                }
            }
            Some(CommandEvent::Error(error)) => process_error = Some(error),
            Some(CommandEvent::Terminated(status)) => {
                if control.is_some_and(ProcessControl::is_cancelled) {
                    return Err("任务已停止".into());
                }
                if status.code == Some(0) && process_error.is_none() {
                    return Ok(());
                }
                return Err(format!(
                    "FFmpeg failed: {}\n{}",
                    process_error.unwrap_or_default(),
                    String::from_utf8_lossy(&stderr)
                ));
            }
            None => return Err("FFmpeg 未返回退出状态".into()),
            _ => {}
        }
    }
}
