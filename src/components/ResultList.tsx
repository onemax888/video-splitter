import { useState, useEffect } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import VideoPlayer from './VideoPlayer';
import { useI18n } from '../i18n/I18nProvider';
import { formatAppError, toAppError } from '../utils/appError';

interface ResultListProps {
    files: string[];
    totalElapsedMs?: number;
}

const ResultList = ({ files, totalElapsedMs }: ResultListProps) => {
    const { t, locale } = useI18n();
    const [previewFile, setPreviewFile] = useState<string | null>(null);
    const [previewDuration, setPreviewDuration] = useState<number | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);

    if (files.length === 0) return null;

    const handleOpenFolder = async () => {
        try {
            if (files.length > 0) {
                await revealItemInDir(files[0]);
            }
        } catch (error) {
            console.error('Failed to open folder:', error);
        }
    };

    const getPathSegments = (path: string) => path.split(/[\\/]/).filter(Boolean);

    const getFileName = (path: string) => {
        const segments = getPathSegments(path);
        return segments[segments.length - 1] || path;
    };

    const getBatchDirName = (path: string) => {
        const segments = getPathSegments(path);
        return segments.length > 1 ? segments[segments.length - 2] : '';
    };

    const formatElapsed = (ms: number | null | undefined) => {
        if (ms === null || ms === undefined) {
            return '—';
        }
        const totalSeconds = Math.max(ms, 0) / 1000;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) {
            return locale === 'zh-CN'
                ? `${hours}小时 ${minutes}分 ${seconds.toFixed(1)}秒`
                : `${hours}h ${minutes}m ${seconds.toFixed(1)}s`;
        }
        if (minutes > 0) {
            return locale === 'zh-CN'
                ? `${minutes}分 ${seconds.toFixed(1)}秒`
                : `${minutes}m ${seconds.toFixed(1)}s`;
        }
        return locale === 'zh-CN'
            ? `${seconds.toFixed(2)}秒`
            : `${seconds.toFixed(2)}s`;
    };

    const handlePlayVideo = (filePath: string) => {
        setPreviewFile(filePath === previewFile ? null : filePath);
    };

    useEffect(() => {
        let cancelled = false;
        setPreviewDuration(null);
        setPreviewError(null);

        if (!previewFile) {
            return () => {
                cancelled = true;
            };
        }

        invoke<{ duration: number }>('get_video_info', { path: previewFile })
            .then((info) => {
                if (!cancelled) {
                    setPreviewDuration(info.duration);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setPreviewError(formatAppError(toAppError(err), t));
                }
            });

        return () => {
            cancelled = true;
        };
    }, [previewFile]);

    return (
        <div className="w-full space-y-3">
            <div className="glass rounded-xl p-4">
                <div className="flex items-center justify-between mb-3 gap-3">
                    <h3 className="text-sm font-medium text-green-600 dark:text-green-400 flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        {t('resultList.title', { count: files.length })}
                    </h3>
                    <div className="flex items-center gap-3">
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                            {t('resultList.subdir')}: {getBatchDirName(files[0]) || '—'}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                            {t('resultList.totalElapsed')}: {formatElapsed(totalElapsedMs)}
                        </div>
                        <button
                            onClick={handleOpenFolder}
                            className="text-xs text-primary-600 dark:text-primary-400 hover:text-primary-500 dark:hover:text-primary-300 transition-colors flex items-center gap-1"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                            {t('resultList.openFolder')}
                        </button>
                    </div>
                </div>

                <div className="max-h-48 overflow-y-auto space-y-1">
                    {files.map((file, index) => (
                        <div
                            key={index}
                            className={`
                flex items-center justify-between gap-2 text-sm py-2 px-3 rounded-lg
                transition-colors cursor-pointer
                ${previewFile === file
                                    ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/30'
                                }
              `}
                            onClick={() => handlePlayVideo(file)}
                        >
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                                <span className="truncate" title={file}>
                                    {getFileName(file)}
                                </span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                                <button
                                    className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                                    title={t('resultList.preview')}
                                >
                                    <svg className="w-4 h-4 text-primary-500" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M8 5v14l11-7z" />
                                    </svg>
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {previewFile && (
                <VideoPlayer
                    filePath={previewFile}
                    title={getFileName(previewFile)}
                    totalDuration={previewDuration ?? undefined}
                    onClose={() => setPreviewFile(null)}
                />
            )}

            {previewError && (
                <div className="text-xs text-red-500">
                    {t('resultList.previewError', { message: previewError })}
                </div>
            )}
        </div>
    );
};

export default ResultList;
