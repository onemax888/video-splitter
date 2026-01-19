import { useI18n } from '../i18n/I18nProvider';

interface ProgressBarProps {
    progress: number;
    currentSegment: number;
    totalSegments: number;
    isProcessing: boolean;
}

const ProgressBar = ({
    progress,
    currentSegment,
    totalSegments,
    isProcessing,
}: ProgressBarProps) => {
    const { t } = useI18n();
    if (!isProcessing && progress === 0) return null;

    return (
        <div className="w-full space-y-3 glass rounded-xl p-4">
            <div className="flex items-center justify-between text-sm">
                <span className="text-slate-600 dark:text-slate-300 font-medium">
                    {isProcessing ? t('progress.processing') : t('progress.done')}
                </span>
                <span className="text-primary-600 dark:text-primary-400 font-mono">
                    {progress.toFixed(0)}%
                </span>
            </div>

            {/* Progress bar */}
            <div className="w-full h-3 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                <div
                    className={`h-full transition-all duration-300 ease-out rounded-full ${isProcessing ? 'progress-shimmer' : 'bg-green-500'
                        }`}
                    style={{ width: `${progress}%` }}
                />
            </div>

            {/* Details */}
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>
                    {t('progress.segmentCount', { current: currentSegment, total: totalSegments })}
                </span>
                <span className="truncate max-w-[200px]" title={isProcessing
                    ? t('progress.processingDetail', { current: currentSegment, total: totalSegments })
                    : t('progress.done')
                }>
                    {isProcessing
                        ? t('progress.processingDetail', { current: currentSegment, total: totalSegments })
                        : t('progress.done')}
                </span>
            </div>
        </div>
    );
};

export default ProgressBar;
