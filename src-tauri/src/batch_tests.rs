use super::*;
use crate::process::run_command;
use serde_json::Value;
use std::process::Command;
use tauri_plugin_shell::ShellExt;

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "video-batch-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn files(dir: &Path, count: usize) -> Vec<String> {
    fs::create_dir_all(dir).unwrap();
    (0..count)
        .map(|index| {
            let file = dir.join(format!("{index:03}.mp4"));
            fs::write(&file, format!("clip{index}")).unwrap();
            file.to_string_lossy().into_owned()
        })
        .collect()
}

#[test]
fn layouts_number_actual_outputs_and_preserve_source_order() {
    for layout in [OutputLayout::PerVideo, OutputLayout::Together] {
        let temp = TempDir::new();
        let root = temp.0.join("out");
        fs::create_dir(&root).unwrap();
        let first = files(&temp.0.join("a"), 1); // Sparse GOP: predicted count can be much larger.
        let second = files(&temp.0.join("b"), 3);
        let a = publish_video(&root, &first, "/one/same.mp4", 0, 1, layout).unwrap();
        let b = publish_video(
            &root,
            &second,
            "/two/same.mp4",
            1,
            if layout == OutputLayout::Together {
                a.len() + 1
            } else {
                1
            },
            layout,
        )
        .unwrap();
        assert!(a[0].ends_with("000001.mp4"));
        assert_eq!(
            Path::new(&b[0]).file_name().unwrap(),
            if layout == OutputLayout::Together {
                "000002.mp4"
            } else {
                "000001.mp4"
            }
        );
        if layout == OutputLayout::PerVideo {
            assert_eq!(
                Path::new(&b[0]).parent().unwrap().file_name().unwrap(),
                "002_same"
            );
        }
        assert_eq!(fs::read(&b[2]).unwrap(), b"clip2");
        if layout == OutputLayout::Together {
            assert_eq!(fs::read_dir(&root).unwrap().count(), 4);
        }
    }
}

#[test]
fn publishing_never_overwrites_and_rolls_back_partial_moves() {
    let temp = TempDir::new();
    let root = temp.0.join("out");
    fs::create_dir(&root).unwrap();
    let source = files(&temp.0.join("stage"), 3);
    fs::write(root.join("000002.mp4"), b"existing").unwrap();
    assert!(publish_video(&root, &source, "test.mp4", 0, 1, OutputLayout::Together).is_err());
    assert_eq!(fs::read(root.join("000002.mp4")).unwrap(), b"existing");
    assert!(!root.join("000001.mp4").exists());
    assert!(source.iter().all(|p| Path::new(p).exists()));
    fs::write(&source[0], b"").unwrap();
    assert!(publish_video(&root, &source, "test.mp4", 0, 1, OutputLayout::PerVideo).is_err());
    assert!(!root.join("001_test").exists());
}

#[test]
fn directories_are_unique_and_manifest_escapes_names_and_records_failures() {
    let temp = TempDir::new();
    let a = create_batch_dir(&temp.0).unwrap();
    let b = create_batch_dir(&temp.0).unwrap();
    assert_ne!(a, b);
    let item = BatchItem {
        input_path: "=name,\"quoted\".mp4".into(),
        status: "success".into(),
        output_files: vec![a.join("000001.mp4").to_string_lossy().into_owned()],
        error: None,
    };
    let failed = BatchItem {
        input_path: "bad.mp4".into(),
        status: "failed".into(),
        output_files: vec![],
        error: Some("bad\nfile".into()),
    };
    write_manifest(&a, &[item, failed]).unwrap();
    let text = fs::read_to_string(a.join("切分清单.csv")).unwrap();
    assert!(text.starts_with('\u{feff}'));
    assert!(text.contains("\"'=name,\"\"quoted\"\".mp4\""));
    assert!(text.contains("\"000001.mp4\""));
    assert!(text.contains("\"failed\",\"bad\nfile\""));
    assert!(!source_folder(0, "bad:*?name.mp4").contains(':'));
    assert!(source_folder(1, "CON.mp4").starts_with("002_"));
}

#[test]
fn output_discovery_uses_numeric_order_without_predicted_count_limit() {
    let temp = TempDir::new();
    for name in ["1000.mp4", "002.mp4", "010.mp4", "note.mp4", "001.mkv"] {
        fs::write(temp.0.join(name), b"clip").unwrap();
    }
    let output = ffmpeg::collect_interval_outputs(&temp.0, "mp4").unwrap();
    let names: Vec<_> = output
        .iter()
        .map(|s| Path::new(s).file_name().unwrap().to_str().unwrap())
        .collect();
    assert_eq!(names, ["002.mp4", "010.mp4", "1000.mp4"]);
}

fn sidecar(name: &str) -> PathBuf {
    let target = match std::env::consts::OS {
        "macos" => format!("{}-apple-darwin", std::env::consts::ARCH),
        "windows" => "x86_64-pc-windows-msvc.exe".into(),
        "linux" => "x86_64-unknown-linux-gnu".into(),
        _ => panic!("unsupported OS"),
    };
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-{target}"))
}
fn run(command: &mut Command) -> Vec<u8> {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

#[tokio::test]
#[ignore = "Runs bundled FFmpeg"]
async fn real_ffmpeg_batch_layouts_and_cancellation() {
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_shell::init())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let temp = TempDir::new();
    let input = temp.0.join("source.mp4");
    run(Command::new(sidecar("ffmpeg"))
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=64x64:r=100",
            "-f",
            "lavfi",
            "-i",
            "sine=sample_rate=48000",
            "-t",
            "2.4",
            "-c:v",
            "libx264",
            "-g",
            "1000",
            "-sc_threshold",
            "0",
            "-c:a",
            "aac",
        ])
        .arg(&input));
    for layout in [OutputLayout::PerVideo, OutputLayout::Together] {
        let root = create_batch_dir(&temp.0).unwrap();
        let mut next = 1;
        for (index, mode) in [IntervalSplitMode::Copy, IntervalSplitMode::Precise]
            .into_iter()
            .enumerate()
        {
            let stage = root.join(".processing");
            fs::create_dir(&stage).unwrap();
            let pattern = stage.join("%03d.mp4");
            // Exercise the actual argument builder, process runner, discovery, and publication.
            let args = ffmpeg::interval_split_args(
                input.to_str().unwrap(),
                pattern.to_str().unwrap(),
                1,
                mode,
            );
            run_command(
                app.shell().command(sidecar("ffmpeg")).args(args),
                Some(&ProcessControl::new("test".into())),
            )
            .await
            .unwrap();
            let actual = ffmpeg::collect_interval_outputs(&stage, "mp4").unwrap();
            assert_eq!(actual.len(), if index == 0 { 1 } else { 3 });
            let outputs = publish_video(
                &root,
                &actual,
                input.to_str().unwrap(),
                index,
                if layout == OutputLayout::Together {
                    next
                } else {
                    1
                },
                layout,
            )
            .unwrap();
            next += outputs.len();
            for (i, path) in outputs.iter().enumerate() {
                let info: Value = serde_json::from_slice(&run(Command::new(sidecar("ffprobe"))
                    .args([
                        "-v",
                        "error",
                        "-show_entries",
                        "stream=codec_type,nb_frames",
                        "-of",
                        "json",
                        path,
                    ])))
                .unwrap();
                let frames = info["streams"][0]["nb_frames"]
                    .as_str()
                    .unwrap()
                    .parse::<u32>()
                    .unwrap();
                assert_eq!(frames, if index == 0 { 240 } else { [100, 100, 40][i] });
                run(Command::new(sidecar("ffmpeg"))
                    .args(["-v", "error", "-xerror", "-i", path, "-f", "null", "-"]));
            }
            fs::remove_dir(&stage).unwrap();
        }
    }
    let control = Arc::new(ProcessControl::new("cancel".into()));
    let cancel = control.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        cancel.cancel();
    });
    let output = temp.0.join("cancel.mp4");
    let command = app.shell().command(sidecar("ffmpeg")).args([
        "-y",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=64x64:r=30",
        "-t",
        "60",
        "-c:v",
        "libx264",
        output.to_str().unwrap(),
    ]);
    let stopped = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        run_command(command, Some(&control)),
    )
    .await
    .unwrap();
    assert!(stopped.unwrap_err().contains("停止"));
    fs::remove_file(output).unwrap(); // Process has released the file before returning.
    let already_cancelled = app.shell().command(sidecar("ffmpeg")).args(["-version"]);
    assert!(run_command(already_cancelled, Some(&control))
        .await
        .is_err());
}
