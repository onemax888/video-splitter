import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { useI18n } from '../i18n/I18nProvider';

interface FileDropZoneProps {
    onFileSelect: (path: string) => void;
    selectedFile: string | null;
    videoInfo: {
        filename: string;
        duration_formatted: string;
        duration: number;
    } | null;
    disabled?: boolean;
}

interface DragDropPayload {
    paths: string[];
    position: { x: number; y: number };
}

const FileDropZone = ({
    onFileSelect,
    selectedFile,
    videoInfo,
    disabled = false,
}: FileDropZoneProps) => {
    const { t } = useI18n();
    const [isDragging, setIsDragging] = useState(false);

    // Listen for Tauri drag-drop events
    useEffect(() => {
        const unlistenDrop = listen<DragDropPayload>('tauri://drag-drop', (event) => {
            if (disabled) return;

            const paths = event.payload.paths;
            if (paths && paths.length > 0) {
                // Get the first file and check if it's a video
                const filePath = paths[0];
                const ext = filePath.split('.').pop()?.toLowerCase();
                const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v'];

                if (ext && videoExts.includes(ext)) {
                    onFileSelect(filePath);
                }
            }
            setIsDragging(false);
        });

        const unlistenEnter = listen('tauri://drag-enter', () => {
            if (!disabled) {
                setIsDragging(true);
            }
        });

        const unlistenLeave = listen('tauri://drag-leave', () => {
            setIsDragging(false);
        });

        return () => {
            unlistenDrop.then(fn => fn());
            unlistenEnter.then(fn => fn());
            unlistenLeave.then(fn => fn());
        };
    }, [disabled, onFileSelect]);

    const handleClick = async () => {
        if (disabled) return;

        const selected = await open({
            multiple: false,
            filters: [
                {
                    name: t('fileDropZone.filterName'),
                    extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v'],
                },
            ],
        });

        if (selected && typeof selected === 'string') {
            onFileSelect(selected);
        }
    };

    return (
        <div className="w-full">
            <div
                onClick={handleClick}
                className={`
          relative w-full p-8 rounded-2xl border-2 border-dashed
          transition-all duration-300 cursor-pointer
          ${disabled
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:border-primary-400 hover:bg-slate-100 dark:hover:bg-slate-800/30'
                    }
          ${isDragging
                        ? 'drop-zone-active border-primary-400 bg-slate-100 dark:bg-slate-800/50'
                        : 'border-slate-300 dark:border-slate-600'
                    }
          ${selectedFile
                        ? 'border-green-500/50 bg-green-50 dark:bg-green-900/10'
                        : 'bg-white/50 dark:bg-transparent'
                    }
        `}
            >
                <div className="flex flex-col items-center justify-center space-y-4">
                    {!selectedFile ? (
                        <>
                            <div className="w-16 h-16 rounded-full bg-slate-100 dark:bg-slate-700/50 flex items-center justify-center">
                                <svg
                                    className="w-8 h-8 text-primary-500 dark:text-primary-400"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                                    />
                                </svg>
                            </div>
                            <div className="text-center">
                                <p className="text-lg font-medium text-slate-700 dark:text-slate-200">
                                    {t('fileDropZone.dragHere')}
                                </p>
                                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                                    {t('fileDropZone.clickSelect')}
                                </p>
                            </div>
                            <p className="text-xs text-slate-400 dark:text-slate-500">
                                {t('fileDropZone.supportFormats')}
                            </p>
                        </>
                    ) : (
                        <>
                            <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                                <svg
                                    className="w-8 h-8 text-green-600 dark:text-green-400"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                                    />
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                    />
                                </svg>
                            </div>
                            <div className="text-center">
                                <p className="text-lg font-medium text-green-600 dark:text-green-400">
                                    📹 {videoInfo?.filename || t('fileDropZone.selected')}
                                </p>
                                {videoInfo && (
                                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                                        {t('common.duration')}: {videoInfo.duration_formatted}
                                    </p>
                                )}
                            </div>
                            <p className="text-xs text-slate-400 dark:text-slate-500">
                                {t('fileDropZone.reselect')}
                            </p>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default FileDropZone;
