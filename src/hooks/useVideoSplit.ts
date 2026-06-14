import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AppendSource } from '../types/append';
import { SeekMode } from '../types/seek';
import { useI18n } from '../i18n/I18nProvider';
import { AppError } from '../types/error';
import { toAppError } from '../utils/appError';

interface VideoInfo {
    path: string;
    duration: number;
    duration_formatted: string;
    filename: string;
    file_size: number;
    width?: number | null;
    height?: number | null;
}

interface SplitProgress {
    current_segment: number;
    total_segments: number;
    percentage: number;
    current_file: string;
}

interface SplitResult {
    success: boolean;
    output_files: string[];
    error: string | null;
    total_elapsed_ms?: number;
    segment_stats?: {
        file: string;
        elapsed_ms: number | null;
    }[];
}

interface TimeRange {
    id: string;
    startTime: number;
    endTime: number;
    label?: string;
}

export function useVideoSplit() {
    const { t } = useI18n();
    const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState<SplitProgress | null>(null);
    const [result, setResult] = useState<SplitResult | null>(null);
    const [error, setError] = useState<AppError | null>(null);

    // Listen for progress events
    useEffect(() => {
        const unlisten = listen<SplitProgress>('split-progress', (event) => {
            setProgress(event.payload);
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, []);

    const loadVideoInfo = useCallback(async (path: string) => {
        setIsLoading(true);
        setError(null);
        setResult(null);
        setProgress(null);

        try {
            const info = await invoke<VideoInfo>('get_video_info', { path });
            setVideoInfo(info);
        } catch (err) {
            setError(toAppError(err));
            setVideoInfo(null);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const splitVideo = useCallback(async (
        inputPath: string,
        outputDir: string,
        segmentDuration: number,
        intro?: AppendSource | null,
        outro?: AppendSource | null,
    ) => {
        setIsProcessing(true);
        setError(null);
        setResult(null);
        setProgress({
            current_segment: 0,
            total_segments: Math.ceil((videoInfo?.duration || 0) / segmentDuration),
            percentage: 0,
            current_file: t('progress.preparing'),
        });

        try {
            const splitResult = await invoke<SplitResult>('split_video_command', {
                inputPath,
                outputDir,
                segmentDuration,
                intro,
                outro,
            });
            setResult(splitResult);
        } catch (err) {
            setError(toAppError(err));
        } finally {
            setIsProcessing(false);
        }
    }, [t, videoInfo]);

    const splitVideoByRanges = useCallback(async (
        inputPath: string,
        outputDir: string,
        ranges: TimeRange[],
        intro?: AppendSource | null,
        outro?: AppendSource | null,
        seekMode: SeekMode = 'accurate',
        fastCopyThresholdSeconds?: number,
    ) => {
        setIsProcessing(true);
        setError(null);
        setResult(null);
        setProgress({
            current_segment: 0,
            total_segments: ranges.length,
            percentage: 0,
            current_file: t('progress.preparing'),
        });

        try {
            const rangesPayload = ranges.map(r => {
                const label = r.label?.trim();
                return {
                    start_seconds: r.startTime,
                    end_seconds: r.endTime,
                    ...(label ? { label } : {}),
                };
            });
            const splitResult = await invoke<SplitResult>('split_video_by_ranges_command', {
                inputPath,
                outputDir,
                ranges: rangesPayload,
                intro,
                outro,
                seekMode,
                fastCopyThresholdSeconds,
            });
            setResult(splitResult);
        } catch (err) {
            setError(toAppError(err));
        } finally {
            setIsProcessing(false);
        }
    }, [t]);

    const reset = useCallback(() => {
        setVideoInfo(null);
        setProgress(null);
        setResult(null);
        setError(null);
    }, []);

    return {
        videoInfo,
        isLoading,
        isProcessing,
        progress,
        result,
        error,
        loadVideoInfo,
        splitVideo,
        splitVideoByRanges,
        reset,
    };
}
