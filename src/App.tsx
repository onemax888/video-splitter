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
import LanguageToggle from './components/LanguageToggle';
import { AppendSource } from './types/append';
import { SeekMode } from './types/seek';
import { IntervalSplitMode } from './types/interval';
import { useVideoSplit } from './hooks/useVideoSplit';
import { useI18n } from './i18n/I18nProvider';
import { formatAppError, toAppError } from './utils/appError';
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
  const { t } = useI18n();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [segmentDuration, setSegmentDuration] = useState(300); // 5 minutes default
  const [durationUnit, setDurationUnit] = useState<'seconds' | 'minutes'>('seconds');
  const [outputDir, setOutputDir] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [ffmpegStatus, setFfmpegStatus] = useState<FFmpegStatus | null>(null);
  const [isCheckingFfmpeg, setIsCheckingFfmpeg] = useState(false);
  const [splitMode, setSplitMode] = useState<'interval' | 'ranges'>('ranges');
  const [intervalMode, setIntervalMode] = useState<IntervalSplitMode>('copy');
  const [timeRanges, setTimeRanges] = useState<TimeRange[]>([]);
  const [introSource, setIntroSource] = useState<AppendSource | null>(null);
  const [outroSource, setOutroSource] = useState<AppendSource | null>(null);
  const [seekMode, setSeekMode] = useState<SeekMode>('balanced');
  const [fastCopyThresholdMinutes, setFastCopyThresholdMinutes] = useState(20);

  const FAST_COPY_THRESHOLD_OPTIONS = [
    { minutes: 0, label: t('range.fastCopy.optionOff') },
    { minutes: 10, label: t('range.fastCopy.option10') },
    { minutes: 20, label: t('range.fastCopy.option20') },
    { minutes: 30, label: t('range.fastCopy.option30') },
    { minutes: 60, label: t('range.fastCopy.option60') },
  ];

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

  const errorMessage = error ? formatAppError(error, t) : '';
  const errorDetail = error?.detail
    || (error?.message && error.message !== errorMessage ? error.message : undefined);

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
    const hasAppend = !!intro || !!outro;
    const effectiveSeekMode: SeekMode = hasAppend ? 'fast' : seekMode;

    if (splitMode === 'interval') {
      await splitVideo(selectedFile, outputDir, segmentDuration, intro, outro, intervalMode);
    } else {
      await splitVideoByRanges(
        selectedFile,
        outputDir,
        timeRanges,
        intro,
        outro,
        effectiveSeekMode,
        fastCopyThresholdMinutes * 60,
      );
    }
  };

  const handleCheckFfmpeg = async () => {
    setIsCheckingFfmpeg(true);
    try {
      const status = await invoke<FFmpegStatus>('check_ffmpeg_command');
      setFfmpegStatus(status);
    } catch (err) {
      const errorMessage = formatAppError(toAppError(err), t);
      setFfmpegStatus({
        found: false,
        ffmpeg_path: null,
        ffprobe_path: null,
        version: null,
        os_info: 'Unknown',
        error: errorMessage,
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

  const hasAppendSources = !!(introSource?.path || outroSource?.path);
  const effectiveSeekMode: SeekMode = hasAppendSources ? 'fast' : seekMode;
  const isFastCopyDisabled = isProcessing || hasAppendSources;

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
            {t('app.checkFfmpeg')}
          </button>
        </div>
        <div className="text-center">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-primary-400 to-cyan-400 bg-clip-text text-transparent">
            {t('app.title')}
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-2">
            {t('app.subtitle')}
          </p>
        </div>
        <div className="flex-1 flex justify-end items-center gap-3">
          <LanguageToggle />
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
                {ffmpegStatus.found ? t('ffmpeg.status.ok') : t('ffmpeg.status.missing')}
              </p>
              {ffmpegStatus.found ? (
                <div className="mt-2 space-y-1 text-xs text-slate-600 dark:text-slate-400">
                  <p>
                    <span className="text-slate-500">{t('ffmpeg.system')}:</span> {ffmpegStatus.os_info}
                  </p>
                  {ffmpegStatus.version && (
                    <p className="truncate" title={ffmpegStatus.version}>
                      <span className="text-slate-500">{t('ffmpeg.version')}:</span> {ffmpegStatus.version}
                    </p>
                  )}
                  {ffmpegStatus.ffmpeg_path && (
                    <p className="truncate" title={ffmpegStatus.ffmpeg_path}>
                      <span className="text-slate-500">{t('ffmpeg.ffmpegPath')}:</span> <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded">{ffmpegStatus.ffmpeg_path}</code>
                    </p>
                  )}
                  {ffmpegStatus.ffprobe_path && (
                    <p className="truncate" title={ffmpegStatus.ffprobe_path}>
                      <span className="text-slate-500">{t('ffmpeg.ffprobePath')}:</span> <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded">{ffmpegStatus.ffprobe_path}</code>
                    </p>
                  )}
                </div>
              ) : (
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                  {ffmpegStatus.error || t('ffmpeg.errorFallback')}
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
              {showPreview ? t('app.preview.hide') : t('app.preview.show')}
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

            {splitMode === 'ranges' && (
              <div className="space-y-2">
                <div className="flex items-center space-x-4">
                  <label className="text-sm font-medium text-slate-600 dark:text-slate-300 w-24">
                    {t('seek.label')}
                  </label>
                  <div className="flex rounded-lg overflow-hidden border border-slate-300 dark:border-slate-600">
                    <button
                      onClick={() => setSeekMode('accurate')}
                      disabled={isProcessing || hasAppendSources}
                      className={`
                        px-4 py-2 text-sm font-medium transition-all duration-200
                        ${effectiveSeekMode === 'accurate'
                          ? 'bg-primary-600 text-white'
                          : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                        }
                        ${isProcessing || hasAppendSources ? 'opacity-50 cursor-not-allowed' : ''}
                      `}
                    >
                      {t('seek.accurate')}
                    </button>
                    <button
                      onClick={() => setSeekMode('balanced')}
                      disabled={isProcessing || hasAppendSources}
                      className={`
                        px-4 py-2 text-sm font-medium transition-all duration-200
                        ${effectiveSeekMode === 'balanced'
                          ? 'bg-primary-600 text-white'
                          : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                        }
                        ${isProcessing || hasAppendSources ? 'opacity-50 cursor-not-allowed' : ''}
                      `}
                    >
                      {t('seek.balanced')}
                    </button>
                    <button
                      onClick={() => setSeekMode('fast')}
                      disabled={isProcessing || hasAppendSources}
                      className={`
                        px-4 py-2 text-sm font-medium transition-all duration-200
                        ${effectiveSeekMode === 'fast'
                          ? 'bg-primary-600 text-white'
                          : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                        }
                        ${isProcessing || hasAppendSources ? 'opacity-50 cursor-not-allowed' : ''}
                      `}
                    >
                      {t('seek.fast')}
                    </button>
                  </div>
                </div>
                {effectiveSeekMode === 'fast' ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400 pl-28">
                    {t('seek.fastDesc')}
                  </p>
                ) : effectiveSeekMode === 'balanced' ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400 pl-28">
                    {t('seek.balancedDesc')}
                  </p>
                ) : (
                  <p className="text-xs text-slate-500 dark:text-slate-400 pl-28">
                    {t('seek.accurateDesc')}
                  </p>
                )}
              </div>
            )}

            {splitMode === 'ranges' && (
              <div className="space-y-2">
                <div className="flex items-center space-x-4">
                  <label className="text-sm font-medium text-slate-600 dark:text-slate-300 w-24">
                    {t('range.fastCopy.label')}
                  </label>
                  <div className="flex rounded-lg overflow-hidden border border-slate-300 dark:border-slate-600">
                    {FAST_COPY_THRESHOLD_OPTIONS.map((option) => (
                      <button
                        key={option.minutes}
                        onClick={() => setFastCopyThresholdMinutes(option.minutes)}
                        disabled={isFastCopyDisabled}
                        className={`
                          px-4 py-2 text-sm font-medium transition-all duration-200
                          ${fastCopyThresholdMinutes === option.minutes
                            ? 'bg-primary-600 text-white'
                            : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                          }
                          ${isFastCopyDisabled ? 'opacity-50 cursor-not-allowed' : ''}
                        `}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 pl-28">
                  {hasAppendSources ? t('range.fastCopy.disabledDesc') : t('range.fastCopy.desc')}
                </p>
              </div>
            )}

            <AppendMediaSelector
              label={t('append.intro')}
              value={introSource}
              onChange={setIntroSource}
              disabled={isProcessing}
            />
            <AppendMediaSelector
              label={t('append.outro')}
              value={outroSource}
              onChange={setOutroSource}
              disabled={isProcessing}
            />
            {splitMode === 'interval' ? (
              <div className="space-y-4">
                <DurationInput
                  value={segmentDuration}
                  onChange={setSegmentDuration}
                  unit={durationUnit}
                  onUnitChange={setDurationUnit}
                  disabled={isProcessing}
                />
                <div className="space-y-2">
                  <div className="flex items-center space-x-4">
                    <label htmlFor="interval-mode" className="text-sm font-medium text-slate-600 dark:text-slate-300 w-24">
                      {t('interval.modeLabel')}
                    </label>
                    <select
                      id="interval-mode"
                      value={hasAppendSources ? 'precise' : intervalMode}
                      onChange={(event) => setIntervalMode(event.target.value as IntervalSplitMode)}
                      disabled={isProcessing || hasAppendSources}
                      aria-describedby="interval-mode-description"
                      className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-white disabled:opacity-50"
                    >
                      <option value="copy">{t('interval.copy')}</option>
                      <option value="precise">{t('interval.precise')}</option>
                    </select>
                  </div>
                  <p id="interval-mode-description" className="text-xs text-slate-500 dark:text-slate-400 pl-28">
                    {hasAppendSources
                      ? t('interval.appendDesc')
                      : t(intervalMode === 'precise' ? 'interval.preciseDesc' : 'interval.copyDesc')}
                  </p>
                </div>
              </div>
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
            isProcessing={isProcessing}
          />
        )}

        {/* Error */}
        {error && (
          <div className="glass rounded-xl p-4 border border-red-500/30 bg-red-900/10 dark:bg-red-900/10">
            <p className="text-red-500 dark:text-red-400 text-sm">
              {t('app.error', { message: errorMessage })}
            </p>
            {(error.code || errorDetail) && (
              <details className="mt-2 text-xs text-red-500 dark:text-red-400">
                <summary className="cursor-pointer select-none text-red-500/90 dark:text-red-300">
                  {t('app.errorDetails')}
                </summary>
                <div className="mt-2 space-y-2">
                  {error.code && (
                    <p className="text-red-500/90 dark:text-red-300">
                      <span className="text-red-500/70 dark:text-red-300/70">{t('app.errorCode')}:</span>{' '}
                      <code className="bg-red-500/10 dark:bg-red-900/30 px-1 rounded">{error.code}</code>
                    </p>
                  )}
                  {errorDetail && (
                    <div>
                      <p className="text-red-500/70 dark:text-red-300/70 mb-1">
                        {t('app.errorDetail')}:
                      </p>
                      <pre className="whitespace-pre-wrap break-words rounded-lg border border-red-500/20 bg-red-500/5 dark:bg-red-900/20 p-2 text-red-500/90 dark:text-red-200/90">
                        {errorDetail}
                      </pre>
                    </div>
                  )}
                </div>
              </details>
            )}
          </div>
        )}

        {/* Result */}
        {result?.success && (
          <ResultList
            files={result.output_files}
            totalElapsedMs={result.total_elapsed_ms}
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
              {t('app.processing')}
            </span>
          ) : (
            t('app.startSplit')
          )}
        </button>

        {/* Info */}
        {videoInfo && !isProcessing && !result && (
          <p className="text-center text-sm text-slate-500 dark:text-slate-500">
            {splitMode === 'interval'
              ? t('app.estimateSegments', { count: Math.ceil(videoInfo.duration / segmentDuration) })
              : t('app.estimateSegments', { count: timeRanges.length })
            }
          </p>
        )}
      </main>

      {/* Footer */}
    </div>
  );
}

export default App;
