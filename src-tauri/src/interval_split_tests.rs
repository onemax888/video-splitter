use super::{interval_split_args, IntervalSplitMode};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

fn sidecar(name: &str) -> PathBuf {
    let target = match std::env::consts::OS {
        "macos" => format!("{}-apple-darwin", std::env::consts::ARCH),
        "windows" => "x86_64-pc-windows-msvc.exe".to_string(),
        "linux" => "x86_64-unknown-linux-gnu".to_string(),
        os => panic!("Unsupported test platform: {os}"),
    };
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-{target}"))
}

fn run(command: &mut Command) -> Vec<u8> {
    let output = command.output().expect("run bundled FFmpeg/FFprobe");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn probe(path: &Path) -> Value {
    serde_json::from_slice(&run(Command::new(sidecar("ffprobe")).args([
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,start_time,duration,nb_frames",
        "-of",
        "json",
        path.to_str().unwrap(),
    ])))
    .unwrap()
}

#[test]
#[ignore = "Runs bundled FFmpeg; cargo test interval_modes -- --ignored"]
fn interval_modes_preserve_frames_with_audio_and_without_audio() {
    let root = std::env::temp_dir().join(format!(
        "video-splitter-interval-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    for with_audio in [true, false] {
        let input = root.join(format!("input-{with_audio}.mp4"));
        let mut generate = Command::new(sidecar("ffmpeg"));
        generate.args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=100"]);
        if with_audio {
            generate.args(["-f", "lavfi", "-i", "sine=sample_rate=48000", "-c:a", "aac"]);
        }
        // Only the first source frame is a keyframe: stream copy cannot cut every second.
        generate
            .args([
                "-t",
                "2.4",
                "-c:v",
                "libx264",
                "-g",
                "1000",
                "-sc_threshold",
                "0",
            ])
            .arg(&input);
        run(&mut generate);
        for (label, mode, expected_frames) in [
            ("copy", IntervalSplitMode::default(), vec![240]),
            ("precise", IntervalSplitMode::Precise, vec![100, 100, 40]),
        ] {
            let dir = root.join(format!("{label}-{with_audio}"));
            std::fs::create_dir(&dir).unwrap();
            let pattern = dir.join("%03d.mp4");
            run(Command::new(sidecar("ffmpeg")).args(interval_split_args(
                input.to_str().unwrap(),
                pattern.to_str().unwrap(),
                1,
                mode,
            )));
            assert_eq!(
                std::fs::read_dir(&dir).unwrap().count(),
                expected_frames.len()
            );
            for (index, frames) in expected_frames.iter().enumerate() {
                let file = dir.join(format!("{index:03}.mp4"));
                let info = probe(&file);
                let streams = info["streams"].as_array().unwrap();
                assert_eq!(streams.len(), if with_audio { 2 } else { 1 });
                let video = &streams[0];
                assert_eq!(
                    video["nb_frames"].as_str().unwrap().parse::<u32>().unwrap(),
                    *frames
                );
                if matches!(mode, IntervalSplitMode::Precise) {
                    let duration = video["duration"].as_str().unwrap().parse::<f64>().unwrap();
                    assert!((duration - *frames as f64 / 100.0).abs() < 0.0001, "{info}");
                    assert!(
                        video["start_time"]
                            .as_str()
                            .unwrap()
                            .parse::<f64>()
                            .unwrap()
                            .abs()
                            < 0.001,
                        "{info}"
                    );
                    let container_duration = info["format"]["duration"]
                        .as_str()
                        .unwrap()
                        .parse::<f64>()
                        .unwrap();
                    assert!((container_duration - duration).abs() < 0.025, "{info}");
                }
                // Every segment must decode independently, including its first frame.
                run(Command::new(sidecar("ffmpeg")).args([
                    "-v",
                    "error",
                    "-xerror",
                    "-i",
                    file.to_str().unwrap(),
                    "-f",
                    "null",
                    "-",
                ]));
            }
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}
