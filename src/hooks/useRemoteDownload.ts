import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AppError } from '../types/error';
import { toAppError } from '../utils/appError';

export type DownloadProvider = 'auto' | 'meowload' | 'onccg';
export type DownloadQuality = 'lowest' | 'best';

export interface ProxyOptions {
    enabled: boolean;
    configPath?: string | null;
    nodeName?: string | null;
}

export interface ProxyConfigInfo {
    configPath: string;
    nodes: string[];
    defaultNode?: string | null;
}

export interface ProxyNodeDelay {
    name: string;
    delayMs?: number | null;
    error?: string | null;
}

export interface RemoteDownloadResult {
    provider: DownloadProvider;
    sourceUrl: string;
    title: string;
    videoPath: string;
    coverPath?: string | null;
    outputDir: string;
    rawDir: string;
    fileSize: number;
}

export interface RemoteDownloadProgress {
    provider: DownloadProvider;
    stage: string;
    percentage: number;
    downloadedBytes: number;
    totalBytes?: number | null;
    currentFile: string;
}

export function useRemoteDownload() {
    const [isDownloading, setIsDownloading] = useState(false);
    const [progress, setProgress] = useState<RemoteDownloadProgress | null>(null);
    const [result, setResult] = useState<RemoteDownloadResult | null>(null);
    const [error, setError] = useState<AppError | null>(null);

    useEffect(() => {
        const unlisten = listen<RemoteDownloadProgress>('remote-download-progress', (event) => {
            setProgress(event.payload);
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, []);

    const download = useCallback(async (
        url: string,
        provider: DownloadProvider,
        quality: DownloadQuality,
        downloadDir?: string | null,
        proxyOptions?: ProxyOptions | null,
    ) => {
        setIsDownloading(true);
        setError(null);
        setResult(null);
        setProgress({
            provider,
            stage: 'preparing',
            percentage: 0,
            downloadedBytes: 0,
            totalBytes: null,
            currentFile: '',
        });

        try {
            const nextResult = await invoke<RemoteDownloadResult>('download_remote_video_command', {
                url,
                provider,
                quality,
                downloadDir: downloadDir?.trim() || null,
                proxyOptions: proxyOptions || null,
            });
            setResult(nextResult);
            return nextResult;
        } catch (err) {
            const appError = toAppError(err);
            setError(appError);
            throw appError;
        } finally {
            setIsDownloading(false);
        }
    }, []);

    const reset = useCallback(() => {
        setProgress(null);
        setResult(null);
        setError(null);
    }, []);

    return {
        isDownloading,
        progress,
        result,
        error,
        download,
        reset,
    };
}
