import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useI18n } from '../i18n/I18nProvider';
import { formatAppError, toAppError } from '../utils/appError';

type TranscriptionModel = 'whisperCpp' | 'funAsr';

interface TranscriptionResult {
    model: TranscriptionModel;
    sourcePath: string;
    audioPath: string;
    textPath: string;
    text: string;
}

interface TranscriptionProgress {
    taskId: string;
    stage: string;
    percentage: number;
    message: string;
    detail: string | null;
}

interface TranscriptionPanelProps {
    sourcePath: string;
    whisperCppDir?: string;
    whisperModelPath?: string;
    disabled?: boolean;
    className?: string;
}

const MODELS: TranscriptionModel[] = ['whisperCpp', 'funAsr'];

const TranscriptionPanel = ({
    sourcePath,
    whisperCppDir = '',
    whisperModelPath = '',
    disabled = false,
    className = '',
}: TranscriptionPanelProps) => {
    const { t } = useI18n();
    const [model, setModel] = useState<TranscriptionModel>('whisperCpp');
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [result, setResult] = useState<TranscriptionResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<TranscriptionProgress | null>(null);
    const taskIdRef = useRef<string | null>(null);

    useEffect(() => {
        const unlisten = listen<TranscriptionProgress>('transcription-progress', (event) => {
            if (event.payload.taskId === taskIdRef.current) {
                setProgress(event.payload);
            }
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, []);

    useEffect(() => {
        setResult(null);
        setError(null);
        setProgress(null);
        taskIdRef.current = null;
    }, [sourcePath]);

    const handleTranscribe = async () => {
        if (!sourcePath || disabled || isTranscribing) {
            return;
        }
        const taskId = `transcription-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        taskIdRef.current = taskId;
        setIsTranscribing(true);
        setError(null);
        setResult(null);
        setProgress({
            taskId,
            stage: 'preparing',
            percentage: 0,
            message: t('transcription.stage.preparing'),
            detail: null,
        });
        try {
            const nextResult = await invoke<TranscriptionResult>('transcribe_media_command', {
                sourcePath,
                model,
                whisperCppDir: whisperCppDir.trim() || null,
                whisperModelPath: whisperModelPath.trim() || null,
                taskId,
            });
            setResult(nextResult);
        } catch (err) {
            const appError = toAppError(err);
            const summary = formatAppError(appError, t);
            const detail = appError.detail || appError.message;
            setError(detail && detail !== summary ? `${summary}：${detail}` : summary);
        } finally {
            setIsTranscribing(false);
            taskIdRef.current = null;
        }
    };

    const progressPercentage = Math.min(Math.max(progress?.percentage ?? 0, 0), 100);
    const progressLabel = progress
        ? t(`transcription.stage.${progress.stage}`, undefined, progress.message || progress.stage)
        : '';

    return (
        <section className={`glass rounded-xl p-4 space-y-3 ${className}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                        {t('transcription.title')}
                    </h2>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {t('transcription.sourceHint')}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <select
                        value={model}
                        onChange={(event) => setModel(event.target.value as TranscriptionModel)}
                        disabled={disabled || isTranscribing}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                        aria-label={t('transcription.model')}
                    >
                        {MODELS.map((item) => (
                            <option key={item} value={item}>
                                {t(`transcription.model.${item}`)}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        onClick={handleTranscribe}
                        disabled={disabled || isTranscribing || !sourcePath}
                        className="rounded-lg bg-primary-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary-500 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 dark:disabled:bg-slate-700 dark:disabled:text-slate-400"
                    >
                        {isTranscribing ? t('transcription.running') : t('transcription.start')}
                    </button>
                </div>
            </div>

            {error && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                    {error}
                </p>
            )}

            {(isTranscribing || progress) && (
                <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900/50">
                    <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                        <span className="truncate">{progressLabel}</span>
                        <span className="font-mono">{Math.round(progressPercentage)}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                        <div
                            className={`h-full rounded-full transition-all duration-300 ${isTranscribing ? 'progress-shimmer' : 'bg-green-500'}`}
                            style={{ width: `${Math.max(progressPercentage, isTranscribing ? 4 : 0)}%` }}
                        />
                    </div>
                    {progress?.detail && isTranscribing && (
                        <p className="truncate text-[11px] text-slate-400 dark:text-slate-500" title={progress.detail}>
                            {progress.detail}
                        </p>
                    )}
                </div>
            )}

            {result && (
                <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <span>{t('transcription.savedTo')}</span>
                        <span className="max-w-full truncate" title={result.textPath}>
                            {result.textPath}
                        </span>
                    </div>
                    <textarea
                        readOnly
                        value={result.text}
                        className="min-h-72 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-800 outline-none dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100 lg:min-h-[32rem]"
                    />
                </div>
            )}
        </section>
    );
};

export default TranscriptionPanel;
