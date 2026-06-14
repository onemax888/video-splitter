import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AppError } from '../types/error';
import { toAppError } from '../utils/appError';

export type DownloadProvider = 'meowloadCli' | 'meowloadApi' | 'onccgApi';
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
    audioPath?: string | null;
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
    const [isCanceling, setIsCanceling] = useState(false);
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
        setIsCanceling(false);
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
            if (appError.message?.includes('下载已取消') || appError.detail?.includes('下载已取消')) {
                setError(null);
                setProgress((current) => (
                    current
                        ? { ...current, stage: 'canceled', percentage: 0 }
                        : {
                            provider,
                            stage: 'canceled',
                            percentage: 0,
                            downloadedBytes: 0,
                            totalBytes: null,
                            currentFile: '',
                        }
                ));
                return null;
            }
            setError(appError);
            throw appError;
        } finally {
            setIsDownloading(false);
            setIsCanceling(false);
        }
    }, []);

    const cancel = useCallback(async () => {
        if (!isDownloading || isCanceling) {
            return;
        }
        setIsCanceling(true);
        setProgress((current) => (
            current
                ? { ...current, stage: 'canceling' }
                : current
        ));
        try {
            await invoke('cancel_remote_download_command');
        } catch (err) {
            const appError = toAppError(err);
            setError(appError);
            setIsCanceling(false);
            throw appError;
        }
    }, [isCanceling, isDownloading]);

    const reset = useCallback(() => {
        setProgress(null);
        setResult(null);
        setError(null);
        setIsCanceling(false);
    }, []);

    return {
        isDownloading,
        isCanceling,
        progress,
        result,
        error,
        download,
        cancel,
        reset,
    };
}
