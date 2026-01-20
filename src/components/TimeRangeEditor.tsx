import { useState, useRef, useEffect, useImperativeHandle, forwardRef, useMemo, type ForwardedRef } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import Hls from 'hls.js';
import { usePreviewSource } from '../hooks/usePreviewSource';
import { useI18n } from '../i18n/I18nProvider';
import { formatAppError } from '../utils/appError';

export interface TimeRange {
    id: string;
    startTime: number;
    endTime: number;
}

interface TimeRangeEditorProps {
    filePath: string;
    duration: number;
    ranges: TimeRange[];
    onAddRange: (range: TimeRange) => void;
    onSetRanges: (ranges: TimeRange[]) => void;
    onUpdateRange: (id: string, range: Partial<TimeRange>) => void;
    onDeleteRange: (id: string) => void;
    disabled?: boolean;
}

export interface TimeRangeEditorRef {
    seekTo: (time: number) => void;
}

const formatTime = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const formatDuration = (seconds: number, locale: string): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins > 0) {
        return locale === 'zh-CN' ? `${mins}分${secs}秒` : `${mins}m ${secs}s`;
    }
    return locale === 'zh-CN' ? `${secs}秒` : `${secs}s`;
};

interface BatchParseLine {
    lineNumber: number;
    raw: string;
    startSeconds: number | null;
    endSeconds: number | null;
    error?: string;
    clamped?: boolean;
}

const TimeRangeEditor = forwardRef(function TimeRangeEditor({
    filePath,
    duration,
    ranges,
    onAddRange,
    onSetRanges,
    onUpdateRange,
    onDeleteRange,
    disabled = false,
}: TimeRangeEditorProps, ref: ForwardedRef<TimeRangeEditorRef>) {
    const { t, locale } = useI18n();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [volume, setVolume] = useState(1);
    const [pendingStart, setPendingStart] = useState<number | null>(null);
    const [editingRangeId, setEditingRangeId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [hlsError, setHlsError] = useState<string | null>(null);
    const [retryToken, setRetryToken] = useState(0);
    const [windowStart, setWindowStart] = useState(0);
    const [pendingSeek, setPendingSeek] = useState<number | null>(null);
    const [queuedSeek, setQueuedSeek] = useState<number | null>(null);
    const [autoPlayAfterSeek, setAutoPlayAfterSeek] = useState(false);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [activeRangeId, setActiveRangeId] = useState<string | null>(null);
    const [hlsStartOffset, setHlsStartOffset] = useState(0);
    const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
    const [showBatchInput, setShowBatchInput] = useState(false);
    const [batchText, setBatchText] = useState('');
    const [batchError, setBatchError] = useState<string | null>(null);
    const [batchOptions, setBatchOptions] = useState({
        merge: true,
        clamp: true,
        ignoreInvalid: true,
    });

    const HLS_MIN_SIZE_DEFAULT = 200 * 1024 * 1024;
    const HLS_SEGMENT_SECONDS = 2;
    const HLS_WINDOW_SECONDS = 4 * 60;
    const HLS_WINDOW_PADDING = 0;
    const forceHls = useMemo(() => {
        const ext = filePath.split('.').pop()?.toLowerCase();
        if (!ext) {
            return false;
        }
        return !['mp4', 'm4v', 'mov'].includes(ext);
    }, [filePath]);
    const hlsMinSize = forceHls ? 0 : HLS_MIN_SIZE_DEFAULT;
    const { source, isPreparing, prepareError } = usePreviewSource(filePath, {
        minSizeBytes: hlsMinSize,
        segmentSeconds: HLS_SEGMENT_SECONDS,
        startSeconds: windowStart,
        windowSeconds: HLS_WINDOW_SECONDS,
        requestKey: retryToken,
    });
    const isUiDisabled = disabled || isPreparing || !!hlsError;

    const parseTimeToSeconds = (input: string): number | null => {
        const cleaned = input.trim();
        if (!cleaned) {
            return null;
        }

        const parts = cleaned.split(':').map((part) => part.trim());
        if (parts.length === 0 || parts.length > 3) {
            return null;
        }

        const nums = parts.map((part) => Number(part));
        if (nums.some((value) => Number.isNaN(value) || value < 0)) {
            return null;
        }

        let hours = 0;
        let minutes = 0;
        let seconds = 0;

        if (nums.length === 3) {
            [hours, minutes, seconds] = nums;
        } else if (nums.length === 2) {
            [minutes, seconds] = nums;
        } else {
            [seconds] = nums;
        }

        return hours * 3600 + minutes * 60 + seconds;
    };

    const parseBatchText = (text: string): BatchParseLine[] => {
        const lines = text.split(/\r?\n/);
        const results: BatchParseLine[] = [];

        lines.forEach((rawLine, index) => {
            const line = rawLine.trim();
            if (!line) {
                return;
            }

            const hasSeparator = /[-~—–,]/.test(line);
            const tokens = hasSeparator
                ? line.split(/\s*(?:-|~|,|—|–)\s*/).filter(Boolean)
                : line.split(/\s+/).filter(Boolean);

            if (tokens.length < 2) {
                results.push({
                    lineNumber: index + 1,
                    raw: line,
                    startSeconds: null,
                    endSeconds: null,
                    error: t('timeRange.batch.errorMissingRange'),
                });
                return;
            }

            const start = parseTimeToSeconds(tokens[0]);
            const end = parseTimeToSeconds(tokens[1]);

            if (start === null || end === null) {
                results.push({
                    lineNumber: index + 1,
                    raw: line,
                    startSeconds: start,
                    endSeconds: end,
                    error: t('timeRange.batch.errorFormat'),
                });
                return;
            }

            if (end <= start) {
                results.push({
                    lineNumber: index + 1,
                    raw: line,
                    startSeconds: start,
                    endSeconds: end,
                    error: t('timeRange.batch.errorEndAfterStart'),
                });
                return;
            }

            let finalStart = start;
            let finalEnd = end;
            let clamped = false;

            if (batchOptions.clamp && duration > 0) {
                finalStart = Math.min(Math.max(finalStart, 0), duration);
                finalEnd = Math.min(Math.max(finalEnd, 0), duration);
                if (finalStart !== start || finalEnd !== end) {
                    clamped = true;
                }
            }

            if (duration > 0 && (finalStart >= duration || finalEnd > duration)) {
                results.push({
                    lineNumber: index + 1,
                    raw: line,
                    startSeconds: finalStart,
                    endSeconds: finalEnd,
                    error: t('timeRange.batch.errorOutOfRange'),
                });
                return;
            }

            if (finalEnd <= finalStart) {
                results.push({
                    lineNumber: index + 1,
                    raw: line,
                    startSeconds: finalStart,
                    endSeconds: finalEnd,
                    error: t('timeRange.batch.errorEndAfterStart'),
                });
                return;
            }

            results.push({
                lineNumber: index + 1,
                raw: line,
                startSeconds: finalStart,
                endSeconds: finalEnd,
                clamped,
            });
        });

        return results;
    };

    const batchPreview = useMemo(() => parseBatchText(batchText), [batchText, batchOptions, duration, t]);
    const validRanges = useMemo(
        () => batchPreview
            .filter((item) => !item.error && item.startSeconds !== null && item.endSeconds !== null)
            .map((item) => ({
                startSeconds: item.startSeconds as number,
                endSeconds: item.endSeconds as number,
            })),
        [batchPreview]
    );
    const validCount = validRanges.length;
    const invalidCount = Math.max(0, batchPreview.length - validCount);
    const uniqueRanges = useMemo(() => {
        const seen = new Map<string, { startSeconds: number; endSeconds: number }>();
        validRanges.forEach((range) => {
            const key = `${range.startSeconds}-${range.endSeconds}`;
            if (!seen.has(key)) {
                seen.set(key, range);
            }
        });
        return Array.from(seen.values());
    }, [validRanges]);
    const duplicateCount = Math.max(0, validRanges.length - uniqueRanges.length);
    const mergedPreview = useMemo(() => mergeRanges(uniqueRanges), [uniqueRanges]);
    const mergedCount = batchOptions.merge ? Math.max(0, uniqueRanges.length - mergedPreview.length) : 0;
    const finalCount = batchOptions.merge ? mergedPreview.length : validRanges.length;

    useEffect(() => {
        setWindowStart(0);
        setPendingSeek(null);
        setQueuedSeek(null);
        setAutoPlayAfterSeek(false);
        setIsScrubbing(false);
        setActiveRangeId(null);
        setHlsStartOffset(0);
        setCurrentTime(0);
        setFrozenFrame(null);
    }, [filePath]);

    useEffect(() => {
        setError(null);
        setHlsError(null);
    }, [source?.kind, source?.path]);

    useEffect(() => {
        if (!source && prepareError) {
            setHlsError(t('timeRange.hls.prepareFailed'));
            setIsLoading(false);
        }
    }, [prepareError, source, t]);

    const timelineDuration = duration;

    const clampTime = (time: number) => {
        if (timelineDuration > 0) {
            return Math.min(Math.max(time, 0), timelineDuration);
        }
        return Math.max(time, 0);
    };

    const computeWindowStart = (time: number) => {
        const padding = Math.min(HLS_WINDOW_PADDING, HLS_WINDOW_SECONDS / 2);
        const maxStart = timelineDuration > 0
            ? Math.max(0, timelineDuration - HLS_WINDOW_SECONDS)
            : Math.max(0, time - padding);
        const rawStart = Math.min(Math.max(time - padding, 0), maxStart);
        return Math.floor(rawStart / HLS_SEGMENT_SECONDS) * HLS_SEGMENT_SECONDS;
    };

    const applyPendingSeek = () => {
        if (pendingSeek === null || !videoRef.current) {
            return;
        }
        const target = clampTime(pendingSeek);
        const relative = source?.kind === 'hls'
            ? Math.max(0, target - windowStart + hlsStartOffset)
            : target;
        videoRef.current.currentTime = relative;
        setCurrentTime(target);
        setPendingSeek(null);
    };

    const captureFrame = () => {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
            return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        setFrozenFrame(canvas.toDataURL('image/jpeg', 0.75));
    };

    const seekToAbsolute = (time: number) => {
        const target = clampTime(time);

        if (!source) {
            captureFrame();
            const nextStart = computeWindowStart(target);
            setWindowStart(nextStart);
            setPendingSeek(target);
            setCurrentTime(target);
            setIsLoading(true);
            return true;
        }

        if (source.kind === 'file') {
            if (videoRef.current) {
                videoRef.current.currentTime = target;
            }
            setCurrentTime(target);
            return false;
        }

        const windowEnd = windowStart + HLS_WINDOW_SECONDS;
        if (target >= windowStart && target <= windowEnd) {
            if (videoRef.current) {
                videoRef.current.currentTime = Math.max(0, target - windowStart + hlsStartOffset);
            }
            setCurrentTime(target);
            return false;
        }

        captureFrame();
        const nextStart = computeWindowStart(target);
        setWindowStart(nextStart);
        setPendingSeek(target);
        setCurrentTime(target);
        setIsLoading(true);
        return true;
    };

    useEffect(() => {
        const video = videoRef.current;
        if (!video || isPreparing || !source) {
            return;
        }

        setHlsError(null);

        if (source.kind === 'file') {
            video.src = convertFileSrc(source.path);
            return;
        }

        const playlistUrl = source.path;
        const canPlayNative = video.canPlayType('application/vnd.apple.mpegurl') !== '';
        if (!Hls.isSupported()) {
            if (canPlayNative) {
                video.src = playlistUrl;
                video.load();
                return;
            }
            video.removeAttribute('src');
            video.load();
            setHlsError(t('timeRange.hls.notSupported'));
            return;
        }

        video.removeAttribute('src');
        video.load();

        const hls = new Hls({
            startPosition: 0,
            maxBufferLength: 30,
            maxBufferSize: 60 * 1024 * 1024,
        });
        hls.loadSource(playlistUrl);
        hls.attachMedia(video);
        const handleStartOffset = (_: unknown, data: any) => {
            const start = data?.details?.fragments?.[0]?.start;
            if (typeof start === 'number' && Number.isFinite(start) && start >= 0) {
                setHlsStartOffset(start);
            }
        };
        hls.on(Hls.Events.LEVEL_LOADED, handleStartOffset);
        hls.on(Hls.Events.LEVEL_UPDATED, handleStartOffset);
        hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) {
                const detail = data.details ? ` (${data.details})` : '';
                setHlsError(t('timeRange.hls.playbackFailed', { detail: `${data.type}${detail}` }));
                hls.destroy();
            }
        });

        return () => {
            hls.off(Hls.Events.LEVEL_LOADED, handleStartOffset);
            hls.off(Hls.Events.LEVEL_UPDATED, handleStartOffset);
            hls.destroy();
        };
    }, [source?.kind, source?.path, isPreparing, retryToken, source, t]);

    useEffect(() => {
        if (videoRef.current && !isPreparing && source?.kind === 'file') {
            videoRef.current.load();
        }
    }, [source?.kind, source?.path, isPreparing]);

    const videoSrc = source?.kind === 'file' ? convertFileSrc(source.path) : undefined;
    const debugSrc = source?.kind === 'hls' ? source.path : (videoSrc || '');

    useImperativeHandle(ref, () => ({
        seekTo: (time: number) => {
            seekToAbsolute(time);
        },
    }));

    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.volume = volume;
        }
    }, [volume]);

    const togglePlay = () => {
        if (!videoRef.current) {
            return;
        }

        if (isPlaying) {
            videoRef.current.pause();
            return;
        }

        if (queuedSeek !== null) {
            const target = queuedSeek;
            setQueuedSeek(null);
            const deferred = seekToAbsolute(target);
            if (deferred) {
                setAutoPlayAfterSeek(true);
                return;
            }
        }

        if (isPreparing) {
            setAutoPlayAfterSeek(true);
            return;
        }

        videoRef.current.play().catch(err => {
            setError(t('timeRange.player.playFailed', { message: err.message }));
        });
    };

    const handleTimeUpdate = () => {
        if (isScrubbing) {
            return;
        }
        if (videoRef.current) {
            const time = videoRef.current.currentTime;
            const baseOffset = source?.kind === 'hls' ? windowStart : 0;
            const absoluteTime = Math.max(0, baseOffset + time - hlsStartOffset);
            setCurrentTime(absoluteTime);

            if (activeRangeId) {
                const activeRange = ranges.find((range) => range.id === activeRangeId);
                if (activeRange && absoluteTime >= activeRange.endTime) {
                    videoRef.current.pause();
                    setIsPlaying(false);
                    setActiveRangeId(null);
                }
            }
        }
    };

    const handleLoadedMetadata = () => {
        setIsLoading(false);
        setError(null);
        applyPendingSeek();
        setFrozenFrame(null);
        if (autoPlayAfterSeek && videoRef.current) {
            setAutoPlayAfterSeek(false);
            videoRef.current.play().catch(() => {});
        }
    };

    const handleCanPlay = () => {
        setIsLoading(false);
        applyPendingSeek();
        setFrozenFrame(null);
        if (autoPlayAfterSeek && videoRef.current) {
            setAutoPlayAfterSeek(false);
            videoRef.current.play().catch(() => {});
        }
    };

    const handleLoadStart = () => {
        setIsLoading(true);
        setError(null);
    };

    const handleError = () => {
        const video = videoRef.current;
        let errorMessage = t('timeRange.player.loadFailed');

        if (video?.error) {
            switch (video.error.code) {
                case MediaError.MEDIA_ERR_ABORTED:
                    errorMessage = t('timeRange.player.loadAborted');
                    break;
                case MediaError.MEDIA_ERR_NETWORK:
                    errorMessage = t('timeRange.player.loadNetworkError');
                    break;
                case MediaError.MEDIA_ERR_DECODE:
                    errorMessage = t('timeRange.player.decodeError');
                    break;
                case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                    errorMessage = t('timeRange.player.notSupported');
                    break;
            }
        }

        setError(errorMessage);
        setIsLoading(false);
    };

    const handleWaiting = () => {
        setIsLoading(true);
    };

    const handlePlaying = () => {
        setIsLoading(false);
        setIsPlaying(true);
    };

    const handleRetry = () => {
        setError(null);
        setHlsError(null);
        setIsLoading(true);
        setRetryToken((value) => value + 1);
        if (videoRef.current) {
            videoRef.current.load();
        }
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const time = parseFloat(e.target.value);
        setCurrentTime(time);
        setQueuedSeek(time);
        if (!videoRef.current || !source) {
            return;
        }
        if (source.kind === 'file') {
            videoRef.current.currentTime = time;
            return;
        }
        const windowEnd = windowStart + HLS_WINDOW_SECONDS;
        if (time >= windowStart && time <= windowEnd) {
            videoRef.current.currentTime = Math.max(0, time - windowStart + hlsStartOffset);
        }
    };

    const handleScrubStart = () => {
        setIsScrubbing(true);
        if (videoRef.current && !videoRef.current.paused) {
            videoRef.current.pause();
            setIsPlaying(false);
        }
    };

    const handleScrubEnd = () => {
        setIsScrubbing(false);
        if (queuedSeek !== null) {
            const target = queuedSeek;
            setQueuedSeek(null);
            seekToAbsolute(target);
        }
    };

    const handleSetStart = () => {
        if (editingRangeId) {
            onUpdateRange(editingRangeId, { startTime: currentTime });
        } else {
            setPendingStart(currentTime);
        }
    };

    const handleSetEnd = () => {
        if (editingRangeId) {
            onUpdateRange(editingRangeId, { endTime: currentTime });
            setEditingRangeId(null);
        } else if (pendingStart !== null) {
            const start = Math.min(pendingStart, currentTime);
            const end = Math.max(pendingStart, currentTime);
            if (end > start) {
                onAddRange({
                    id: crypto.randomUUID(),
                    startTime: start,
                    endTime: end,
                });
            }
            setPendingStart(null);
        }
    };

    const handleCancelPending = () => {
        setPendingStart(null);
        setEditingRangeId(null);
    };

    const handleEditRange = (range: TimeRange) => {
        setEditingRangeId(range.id);
        setPendingStart(null);
        if (videoRef.current) {
            videoRef.current.currentTime = range.startTime;
            setCurrentTime(range.startTime);
        }
    };

    const handlePreviewRange = (range: TimeRange) => {
        if (!videoRef.current) {
            return;
        }
        const isSameRange = activeRangeId === range.id;
        if (isSameRange && isPlaying) {
            videoRef.current.pause();
            setIsPlaying(false);
            return;
        }

        if (!isSameRange && isPlaying) {
            videoRef.current.pause();
            setIsPlaying(false);
        }

        const shouldSeek = !isSameRange || currentTime < range.startTime || currentTime > range.endTime;
        const deferred = shouldSeek ? seekToAbsolute(range.startTime) : false;
        setActiveRangeId(range.id);

        if (deferred) {
            setAutoPlayAfterSeek(true);
            return;
        }

        videoRef.current.play().catch(() => {});
    };

    const getTimelineMarkers = () => {
        if (timelineDuration <= 0) {
            return [];
        }
        return ranges.map((range) => ({
            left: (range.startTime / timelineDuration) * 100,
            width: ((range.endTime - range.startTime) / timelineDuration) * 100,
            id: range.id,
        }));
    };

    function mergeRanges(items: { startSeconds: number; endSeconds: number }[]) {
        const sorted = [...items].sort((a, b) => a.startSeconds - b.startSeconds);
        const merged: { startSeconds: number; endSeconds: number }[] = [];
        sorted.forEach((range) => {
            const last = merged[merged.length - 1];
            if (last && range.startSeconds <= last.endSeconds) {
                last.endSeconds = Math.max(last.endSeconds, range.endSeconds);
            } else {
                merged.push({ ...range });
            }
        });
        return merged;
    }

    const applyBatchRanges = (mode: 'replace' | 'append') => {
        setBatchError(null);
        if (!batchOptions.ignoreInvalid && invalidCount > 0) {
            setBatchError(t('timeRange.batch.errorInvalidLines'));
            return;
        }

        if (validRanges.length === 0) {
            setBatchError(t('timeRange.batch.errorNoValid'));
            return;
        }

        const normalized = batchOptions.merge ? mergeRanges(validRanges) : validRanges;
        const nextRanges: TimeRange[] = normalized.map((item) => ({
            id: crypto.randomUUID(),
            startTime: item.startSeconds,
            endTime: item.endSeconds,
        }));

        if (mode === 'replace') {
            onSetRanges(nextRanges);
        } else {
            onSetRanges([...ranges, ...nextRanges]);
        }

        setShowBatchInput(false);
        setBatchText('');
        setBatchError(null);
    };

    return (
        <div className="glass rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300 flex items-center gap-2">
                        <svg className="w-4 h-4 text-primary-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        {t('timeRange.title')}
                    </h3>
                </div>
                <div className="flex items-center gap-3">
                    {(pendingStart !== null || editingRangeId) && (
                        <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                            <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                            {editingRangeId ? t('timeRange.editing') : t('timeRange.pendingStart', { time: formatTime(pendingStart!) })}
                        </span>
                    )}
                    <button
                        onClick={() => {
                            setBatchError(null);
                            setShowBatchInput(true);
                        }}
                        disabled={isUiDisabled}
                        className="px-3 py-1 text-xs font-medium rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors disabled:opacity-50"
                    >
                        {t('timeRange.batch.open')}
                    </button>
                </div>
            </div>

            <div className="relative bg-black min-h-[200px]">
                <video
                    ref={videoRef}
                    src={videoSrc}
                    className="w-full max-h-[300px]"
                    preload="metadata"
                    onLoadStart={handleLoadStart}
                    onLoadedMetadata={handleLoadedMetadata}
                    onCanPlay={handleCanPlay}
                    onTimeUpdate={handleTimeUpdate}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => {
                        setIsPlaying(false);
                        setActiveRangeId(null);
                    }}
                    onError={handleError}
                    onWaiting={handleWaiting}
                    onPlaying={handlePlaying}
                />

                {/* Loading overlay */}
                {(isLoading || isPreparing) && !error && !hlsError && (
                    <div className="absolute inset-0">
                        {frozenFrame && (
                            <img
                                src={frozenFrame}
                                alt=""
                                className="absolute inset-0 w-full h-full object-cover"
                            />
                        )}
                        <div className="absolute inset-0 bg-black/50" />
                        <div className="relative flex flex-col items-center justify-center h-full">
                            <div className="flex flex-col items-center gap-3">
                                <svg className="animate-spin h-8 w-8 text-primary-500" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                </svg>
                                <span className="text-white text-sm">
                                    {isPreparing ? t('timeRange.hls.preparing') : t('timeRange.player.loading')}
                                </span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Error overlay */}
                {(error || hlsError) && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70">
                        <div className="flex flex-col items-center gap-3 px-4 text-center">
                            <svg className="w-10 h-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <span className="text-white text-sm">{error || hlsError}</span>
                            {prepareError && (
                                <div className="text-[10px] text-slate-300">
                                    {t('timeRange.hls.prepareFailedDetail', { message: formatAppError(prepareError, t) })}
                                </div>
                            )}
                            <div className="mt-2 p-2 bg-black/40 rounded text-[9px] font-mono text-slate-400 break-all max-w-[80%] border border-white/10 text-left">
                                <div className="text-slate-500 mb-1">{t('timeRange.errorCode')}: {videoRef.current?.error?.code}</div>
                                <div className="text-slate-500 mb-1">{t('timeRange.path')}:</div>
                                {debugSrc}
                            </div>
                            <button
                                onClick={handleRetry}
                                className="px-3 py-1.5 bg-primary-500 hover:bg-primary-600 text-white text-sm rounded-lg transition-colors"
                            >
                                {t('common.retry')}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <div className="px-4 py-3 space-y-3 bg-slate-50 dark:bg-slate-800/50">
                <div className="relative">
                    <div className="absolute inset-0 flex items-center pointer-events-none" style={{ height: '4px', top: '50%', transform: 'translateY(-50%)' }}>
                        {getTimelineMarkers().map((marker) => (
                            <div
                                key={marker.id}
                                className="absolute h-full bg-primary-500/40 rounded"
                                style={{ left: `${marker.left}%`, width: `${marker.width}%` }}
                            />
                        ))}
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500 dark:text-slate-400 font-mono w-16">
                            {formatTime(currentTime)}
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={timelineDuration || 100}
                            step={0.1}
                            value={currentTime}
                            onChange={handleSeek}
                            onPointerDown={handleScrubStart}
                            onPointerUp={handleScrubEnd}
                            disabled={isUiDisabled}
                            className="flex-1 h-1 bg-slate-300 dark:bg-slate-600 rounded-full appearance-none cursor-pointer relative z-10
                                [&::-webkit-slider-thumb]:appearance-none
                                [&::-webkit-slider-thumb]:w-3
                                [&::-webkit-slider-thumb]:h-3
                                [&::-webkit-slider-thumb]:rounded-full
                                [&::-webkit-slider-thumb]:bg-primary-500
                                [&::-webkit-slider-thumb]:cursor-pointer
                            "
                        />
                        <span className="text-xs text-slate-500 dark:text-slate-400 font-mono w-16 text-right">
                            {formatTime(timelineDuration)}
                        </span>
                    </div>
                </div>

                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={togglePlay}
                            disabled={isUiDisabled}
                            className="p-2 rounded-full bg-primary-500 hover:bg-primary-600 text-white transition-colors disabled:opacity-50"
                        >
                            {isPlaying ? (
                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                                </svg>
                            ) : (
                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M8 5v14l11-7z" />
                                </svg>
                            )}
                        </button>
                        <div className="flex items-center gap-1">
                            <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                            </svg>
                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.1}
                                value={volume}
                                onChange={(e) => setVolume(parseFloat(e.target.value))}
                                disabled={isUiDisabled}
                                className="w-16 h-1 bg-slate-300 dark:bg-slate-600 rounded-full appearance-none cursor-pointer
                                    [&::-webkit-slider-thumb]:appearance-none
                                    [&::-webkit-slider-thumb]:w-2
                                    [&::-webkit-slider-thumb]:h-2
                                    [&::-webkit-slider-thumb]:rounded-full
                                    [&::-webkit-slider-thumb]:bg-slate-500
                                    [&::-webkit-slider-thumb]:cursor-pointer
                                "
                            />
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        {(pendingStart !== null || editingRangeId) && (
                            <button
                                onClick={handleCancelPending}
                                disabled={isUiDisabled}
                                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors disabled:opacity-50"
                            >
                                {t('common.cancel')}
                            </button>
                        )}
                        <button
                            onClick={handleSetStart}
                            disabled={isUiDisabled}
                            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors disabled:opacity-50 flex items-center gap-1"
                        >
                            <span>📍</span> {t('timeRange.setStart')}
                        </button>
                        <button
                            onClick={handleSetEnd}
                            disabled={isUiDisabled || (pendingStart === null && !editingRangeId)}
                            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50 flex items-center gap-1"
                        >
                            <span>📍</span> {t('timeRange.setEnd')}
                        </button>
                    </div>
                </div>
            </div>

            {ranges.length > 0 && (
                <div className="border-t border-slate-200 dark:border-slate-700">
                    <div className="px-4 py-2 bg-slate-100 dark:bg-slate-800">
                        <h4 className="text-xs font-medium text-slate-600 dark:text-slate-400">
                            {t('timeRange.selectedRanges', { count: ranges.length })}
                        </h4>
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                        {ranges.map((range, index) => (
                            <div
                                key={range.id}
                                className={`flex items-center justify-between px-4 py-2 border-b border-slate-100 dark:border-slate-700/50 last:border-b-0 ${editingRangeId === range.id ? 'bg-amber-50 dark:bg-amber-900/20' : ''
                                    }`}
                            >
                                <div className="flex items-center gap-3">
                                    <span className="w-6 h-6 flex items-center justify-center rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400 text-xs font-medium">
                                        {index + 1}
                                    </span>
                                    <div className="text-sm">
                                        <span className="font-mono text-slate-700 dark:text-slate-300">
                                            {formatTime(range.startTime)}
                                        </span>
                                        <span className="text-slate-400 mx-2">→</span>
                                        <span className="font-mono text-slate-700 dark:text-slate-300">
                                            {formatTime(range.endTime)}
                                        </span>
                                        <span className="text-xs text-slate-500 dark:text-slate-500 ml-2">
                                            ({formatDuration(range.endTime - range.startTime, locale)})
                                        </span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => handlePreviewRange(range)}
                                        disabled={isUiDisabled}
                                        className="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 transition-colors disabled:opacity-50"
                                        title={t('common.preview')}
                                    >
                                        {activeRangeId === range.id && isPlaying ? (
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 8v8m4-8v8" />
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                        ) : (
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                        )}
                                    </button>
                                    <button
                                        onClick={() => handleEditRange(range)}
                                        disabled={isUiDisabled}
                                        className="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 transition-colors disabled:opacity-50"
                                        title={t('common.edit')}
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                        </svg>
                                    </button>
                                    <button
                                        onClick={() => onDeleteRange(range.id)}
                                        disabled={isUiDisabled}
                                        className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50"
                                        title={t('common.delete')}
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {showBatchInput && typeof document !== 'undefined' && createPortal(
                <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4">
                    <div className="w-full max-w-4xl rounded-2xl bg-white dark:bg-slate-900 shadow-xl border border-slate-200 dark:border-slate-700">
                        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700">
                            <div>
                                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('timeRange.batch.title')}</h4>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400">{t('timeRange.batch.subtitle')}</p>
                            </div>
                            <button
                                onClick={() => setShowBatchInput(false)}
                                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        <div className="p-5 space-y-4">
                            <div className="grid gap-4 md:grid-cols-[1.2fr_1fr] items-start">
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between h-6">
                                        <label className="text-xs font-medium text-slate-600 dark:text-slate-300 leading-none">{t('timeRange.batch.inputLabel')}</label>
                                        <button
                                            onClick={() => setBatchText(`00:05:00 00:07:00\n01:05:00 01:10:00\n02:15:30 02:17:40`)}
                                            className="text-[11px] text-primary-500 hover:text-primary-600 leading-none"
                                        >
                                            {t('timeRange.batch.fillExample')}
                                        </button>
                                    </div>
                                    <textarea
                                        value={batchText}
                                        onChange={(e) => setBatchText(e.target.value)}
                                        placeholder={t('timeRange.batch.placeholder')}
                                        className="w-full h-40 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs font-mono text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                                    />
                                    <div className="text-[11px] text-slate-500 dark:text-slate-400 space-y-1">
                                        <div>{t('timeRange.batch.formatHelp')}</div>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between h-6">
                                        <label className="text-xs font-medium text-slate-600 dark:text-slate-300 leading-none">{t('timeRange.batch.previewLabel')}</label>
                                        <span className="text-[11px] opacity-0 select-none leading-none">{t('timeRange.batch.fillExample')}</span>
                                    </div>
                                    <div className="h-40 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 p-2 space-y-1">
                                        {batchPreview.length === 0 && (
                                            <div className="text-[11px] text-slate-400 text-center py-6">{t('timeRange.batch.empty')}</div>
                                        )}
                                        {batchPreview.map((item) => {
                                            const isError = !!item.error;
                                            const durationSeconds = item.endSeconds !== null && item.startSeconds !== null
                                                ? item.endSeconds - item.startSeconds
                                                : 0;
                                            return (
                                                <div
                                                    key={`${item.lineNumber}-${item.raw}`}
                                                    className={`rounded-md px-2 py-1 text-[11px] font-mono ${isError ? 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-300' : 'bg-white text-slate-600 dark:bg-slate-900/40 dark:text-slate-200'}`}
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="text-slate-400 dark:text-slate-500">#{item.lineNumber}</span>
                                                        {isError ? (
                                                            <span className="flex-1 text-right">{item.error}</span>
                                                        ) : (
                                                            <span className="flex-1 text-right">
                                                                {formatTime(item.startSeconds || 0)} → {formatTime(item.endSeconds || 0)}
                                                                {durationSeconds > 0 && ` (${formatDuration(durationSeconds, locale)})`}
                                                            </span>
                                                        )}
                                                    </div>
                                                    {!isError && item.clamped && (
                                                        <div className="text-[10px] text-amber-600 dark:text-amber-400 text-right">{t('timeRange.batch.clamped')}</div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center justify-between">
                                        <span>{t('timeRange.batch.validCount', { count: validCount })}</span>
                                        <span>{t('timeRange.batch.invalidCount', { count: invalidCount })}</span>
                                    </div>
                                    <div className="text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-3">
                                        <span>{t('timeRange.batch.finalCount', { count: finalCount })}</span>
                                        <span>{t('timeRange.batch.duplicateCount', { count: duplicateCount })}</span>
                                        <span>{t('timeRange.batch.mergeCount', { count: mergedCount })}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-300">
                                <label className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={batchOptions.merge}
                                        onChange={(e) => setBatchOptions((prev) => ({ ...prev, merge: e.target.checked }))}
                                        className="rounded border-slate-300 dark:border-slate-600"
                                    />
                                    {t('timeRange.batch.optionMerge')}
                                </label>
                                <label className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={batchOptions.clamp}
                                        onChange={(e) => setBatchOptions((prev) => ({ ...prev, clamp: e.target.checked }))}
                                        className="rounded border-slate-300 dark:border-slate-600"
                                    />
                                    {t('timeRange.batch.optionClamp')}
                                </label>
                                <label className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={batchOptions.ignoreInvalid}
                                        onChange={(e) => setBatchOptions((prev) => ({ ...prev, ignoreInvalid: e.target.checked }))}
                                        className="rounded border-slate-300 dark:border-slate-600"
                                    />
                                    {t('timeRange.batch.optionIgnore')}
                                </label>
                            </div>

                            {batchError && (
                                <div className="text-xs text-red-500">{batchError}</div>
                            )}

                            <div className="flex flex-wrap items-center justify-end gap-2">
                                <button
                                    onClick={() => {
                                        setBatchText('');
                                        setBatchError(null);
                                    }}
                                    className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                                >
                                    {t('common.clearInput')}
                                </button>
                                <button
                                    onClick={() => applyBatchRanges('append')}
                                    className="px-3 py-2 text-xs rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600"
                                >
                                    {t('timeRange.batch.importAppend')}
                                </button>
                                <button
                                    onClick={() => applyBatchRanges('replace')}
                                    className="px-3 py-2 text-xs rounded-lg bg-primary-500 text-white hover:bg-primary-600"
                                >
                                    {t('timeRange.batch.importReplace')}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
});

TimeRangeEditor.displayName = 'TimeRangeEditor';

export default TimeRangeEditor;
