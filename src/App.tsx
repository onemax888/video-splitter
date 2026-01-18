import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import FileDropZone from './components/FileDropZone';
import DurationInput from './components/DurationInput';
import OutputSelector from './components/OutputSelector';
import ProgressBar from './components/ProgressBar';
import ResultList from './components/ResultList';
import ThemeToggle from './components/ThemeToggle';
import VideoPlayer from './components/VideoPlayer';
import SplitModeSelector from './components/SplitModeSelector';
import TimeRangeEditor, { TimeRange } from './components/TimeRangeEditor';
import AppendMediaSelector from './components/AppendMediaSelector';
import { AppendSource } from './types/append';
import { useVideoSplit } from './hooks/useVideoSplit';
import './index.css';

interface FFmpegStatus {
  found: boolean;
  ffmpeg_path: string | null;
  ffprobe_path: string | null;
  version: string | null;
  os_info: string;
  error: string | null;
}

function App() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [segmentDuration, setSegmentDuration] = useState(300); // 5 minutes default
  const [durationUnit, setDurationUnit] = useState<'seconds' | 'minutes'>('seconds');
  const [outputDir, setOutputDir] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [ffmpegStatus, setFfmpegStatus] = useState<FFmpegStatus | null>(null);
  const [isCheckingFfmpeg, setIsCheckingFfmpeg] = useState(false);
  const [splitMode, setSplitMode] = useState<'interval' | 'ranges'>('ranges');
  const [timeRanges, setTimeRanges] = useState<TimeRange[]>([]);
  const [introSource, setIntroSource] = useState<AppendSource | null>(null);
  const [outroSource, setOutroSource] = useState<AppendSource | null>(null);

  const {
    videoInfo,
    isLoading,
    isProcessing,
    progress,
    result,
    error,
    loadVideoInfo,
    splitVideo,
    splitVideoByRanges,
  } = useVideoSplit();

  // Set default output directory to same as input file
  useEffect(() => {
    if (selectedFile && !outputDir) {
      const dir = selectedFile.substring(0, selectedFile.lastIndexOf('/'));
      setOutputDir(dir);
    }
  }, [selectedFile, outputDir]);

  const handleFileSelect = async (path: string) => {
    setSelectedFile(path);
    setShowPreview(false);
    setTimeRanges([]);
    await loadVideoInfo(path);
  };

  const handleAddRange = (range: TimeRange) => {
    setTimeRanges([...timeRanges, range]);
  };

  const handleUpdateRange = (id: string, newRange: Partial<TimeRange>) => {
    setTimeRanges(timeRanges.map(r => r.id === id ? { ...r, ...newRange } : r));
  };

  const handleDeleteRange = (id: string) => {
    setTimeRanges(timeRanges.filter(r => r.id !== id));
  };

  const handleSetRanges = (nextRanges: TimeRange[]) => {
    setTimeRanges(nextRanges);
  };

  const handleSplit = async () => {
    if (!selectedFile || !outputDir) return;

    const normalizeAppend = (source: AppendSource | null) => {
      if (!source || !source.path) return null;
      if (source.kind === 'image' && (!source.durationSeconds || source.durationSeconds <= 0)) {
        return null;
      }
      return source;
    };

    const intro = normalizeAppend(introSource);
    const outro = normalizeAppend(outroSource);

    if (splitMode === 'interval') {
      await splitVideo(selectedFile, outputDir, segmentDuration, intro, outro);
    } else {
      await splitVideoByRanges(selectedFile, outputDir, timeRanges, intro, outro);
    }
  };

  const handleCheckFfmpeg = async () => {
    setIsCheckingFfmpeg(true);
    try {
      const status = await invoke<FFmpegStatus>('check_ffmpeg_command');
      setFfmpegStatus(status);
    } catch (err) {
      setFfmpegStatus({
        found: false,
        ffmpeg_path: null,
        ffprobe_path: null,
        version: null,
        os_info: 'Unknown',
        error: String(err),
      });
    } finally {
      setIsCheckingFfmpeg(false);
    }
  };

  const isAppendReady = (source: AppendSource | null) => {
    if (!source) return true;
    if (!source.path) return false;
    if (source.kind === 'image') {
      return !!source.durationSeconds && source.durationSeconds > 0;
    }
    return true;
  };

  const canSplit = selectedFile && outputDir && videoInfo && !isProcessing && !isLoading &&
    isAppendReady(introSource) && isAppendReady(outroSource) &&
    (splitMode === 'interval' ? segmentDuration > 0 : timeRanges.length > 0);

  return (
    <div className="min-h-screen p-6 flex flex-col transition-colors duration-300">
      {/* Header */}
      <header className="flex items-center justify-between mb-8">
        <div className="flex-1">
          <button
            onClick={handleCheckFfmpeg}
            disabled={isCheckingFfmpeg}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors flex items-center gap-1.5"
          >
            {isCheckingFfmpeg ? (
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            检测 FFmpeg
          </button>
        </div>
        <div className="text-center">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-primary-400 to-cyan-400 bg-clip-text text-transparent">
            🎬 Video Clipping
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-2">
            高效的视频切片工具
          </p>
        </div>
        <div className="flex-1 flex justify-end">
          <ThemeToggle />
        </div>
      </header>

      {/* FFmpeg Status */}
      {ffmpegStatus && (
        <div className={`mb-6 max-w-2xl mx-auto w-full glass rounded-xl p-4 ${ffmpegStatus.found ? 'border border-green-500/30' : 'border border-red-500/30'}`}>
          <div className="flex items-start gap-3">
            {ffmpegStatus.found ? (
              <svg className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <div className="flex-1 min-w-0">
              <p className={`font-medium text-sm ${ffmpegStatus.found ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {ffmpegStatus.found ? 'FFmpeg 检测成功 ✓' : '内置 FFmpeg 未找到'}
              </p>
              {ffmpegStatus.found ? (
                <div className="mt-2 space-y-1 text-xs text-slate-600 dark:text-slate-400">
                  <p>
                    <span className="text-slate-500">系统:</span> {ffmpegStatus.os_info}
                  </p>
                  {ffmpegStatus.version && (
                    <p className="truncate" title={ffmpegStatus.version}>
                      <span className="text-slate-500">版本:</span> {ffmpegStatus.version}
                    </p>
                  )}
                  {ffmpegStatus.ffmpeg_path && (
                    <p className="truncate" title={ffmpegStatus.ffmpeg_path}>
                      <span className="text-slate-500">ffmpeg:</span> <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded">{ffmpegStatus.ffmpeg_path}</code>
                    </p>
                  )}
                  {ffmpegStatus.ffprobe_path && (
                    <p className="truncate" title={ffmpegStatus.ffprobe_path}>
                      <span className="text-slate-500">ffprobe:</span> <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded">{ffmpegStatus.ffprobe_path}</code>
                    </p>
                  )}
                </div>
              ) : (
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                  {ffmpegStatus.error || '内置 FFmpeg 异常，请重新安装应用。'}
                </p>
              )}
            </div>
            <button
              onClick={() => setFfmpegStatus(null)}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 max-w-2xl mx-auto w-full space-y-6">
        {/* File Drop Zone */}
        <FileDropZone
          onFileSelect={handleFileSelect}
          selectedFile={selectedFile}
          videoInfo={videoInfo}
          disabled={isProcessing}
        />

        {/* Video Preview Button & Player */}
        {selectedFile && videoInfo && (
          <div className="space-y-4">
            <button
              onClick={() => setShowPreview(!showPreview)}
              className="w-full py-2 rounded-lg glass text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center justify-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {showPreview ? '隐藏预览' : '预览视频'}
            </button>

            {showPreview && (
              <VideoPlayer
                filePath={selectedFile}
                title={videoInfo.filename}
                fileSize={videoInfo.file_size}
                totalDuration={videoInfo.duration}
                onClose={() => setShowPreview(false)}
              />
            )}
          </div>
        )}

        {/* Settings */}
        {videoInfo && (
          <div className="glass rounded-xl p-5 space-y-5">
            <SplitModeSelector
              mode={splitMode}
              onChange={setSplitMode}
              disabled={isProcessing}
            />

            <AppendMediaSelector
              label="🎬 片头"
              value={introSource}
              onChange={setIntroSource}
              disabled={isProcessing}
            />
            <AppendMediaSelector
              label="🎬 片尾"
              value={outroSource}
              onChange={setOutroSource}
              disabled={isProcessing}
            />
            {(introSource || outroSource) && (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                开启片头/片尾会进行重新编码，速度会慢于无损切分。
              </p>
            )}

            {splitMode === 'interval' ? (
              <DurationInput
                value={segmentDuration}
                onChange={setSegmentDuration}
                unit={durationUnit}
                onUnitChange={setDurationUnit}
                disabled={isProcessing}
              />
            ) : (
              selectedFile && (
                <TimeRangeEditor
                  filePath={selectedFile}
                  duration={videoInfo.duration}
                  ranges={timeRanges}
                  onAddRange={handleAddRange}
                  onSetRanges={handleSetRanges}
                  onUpdateRange={handleUpdateRange}
                  onDeleteRange={handleDeleteRange}
                  disabled={isProcessing}
                />
              )
            )}

            <OutputSelector
              value={outputDir}
              onChange={setOutputDir}
              disabled={isProcessing}
            />
          </div>
        )}

        {/* Progress */}
        {(isProcessing || (progress && progress.percentage > 0)) && (
          <ProgressBar
            progress={progress?.percentage || 0}
            currentSegment={progress?.current_segment || 0}
            totalSegments={progress?.total_segments || 0}
            currentFile={progress?.current_file || ''}
            isProcessing={isProcessing}
          />
        )}

        {/* Error */}
        {error && (
          <div className="glass rounded-xl p-4 border border-red-500/30 bg-red-900/10 dark:bg-red-900/10">
            <p className="text-red-500 dark:text-red-400 text-sm">
              ❌ 错误: {error}
            </p>
          </div>
        )}

        {/* Result */}
        {result?.success && (
          <ResultList
            files={result.output_files}
          />
        )}

        {/* Split Button */}
        <button
          onClick={handleSplit}
          disabled={!canSplit}
          className={`
            w-full py-4 rounded-xl font-semibold text-lg
            transition-all duration-300 transform
            ${canSplit
              ? 'bg-gradient-to-r from-primary-600 to-cyan-600 text-white hover:from-primary-500 hover:to-cyan-500 hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-primary-500/25'
              : 'bg-slate-300 dark:bg-slate-700 text-slate-500 dark:text-slate-400 cursor-not-allowed'
            }
          `}
        >
          {isProcessing ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              处理中...
            </span>
          ) : (
            '🚀 开始切分'
          )}
        </button>

        {/* Info */}
        {videoInfo && !isProcessing && !result && (
          <p className="text-center text-sm text-slate-500 dark:text-slate-500">
            {splitMode === 'interval'
              ? `预计将切分为 ${Math.ceil(videoInfo.duration / segmentDuration)} 个片段`
              : `预计将切分为 ${timeRanges.length} 个片段`
            }
          </p>
        )}
      </main>

      {/* Footer */}
      <footer className="text-center mt-8 text-xs text-slate-500 dark:text-slate-600">
        Powered by FFmpeg & Tauri
      </footer>
    </div>
  );
}

export default App;
