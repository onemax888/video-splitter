import React, { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';

export interface TimeRange {
    id: string;
    start: number;
    end: number;
}

interface RangeSelectorProps {
    ranges: TimeRange[];
    onChange: (ranges: TimeRange[]) => void;
    currentTime: number;
    duration: number;
    onSeek: (time: number) => void;
    disabled?: boolean;
}

const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const RangeSelector = ({
    ranges,
    onChange,
    currentTime,
    duration,
    onSeek,
    disabled = false,
}: RangeSelectorProps) => {
    const { t } = useI18n();
    const [start, setStart] = useState<number>(0);
    const [end, setEnd] = useState<number>(0);

    const handleAdd = () => {
        if (end <= start) return;
        
        const newRange: TimeRange = {
            id: Date.now().toString(),
            start,
            end,
        };
        
        const newRanges = [...ranges, newRange].sort((a, b) => a.start - b.start);
        onChange(newRanges);
        
        setStart(end);
        setEnd(Math.min(end + 10, duration));
    };

    const handleRemove = (id: string) => {
        onChange(ranges.filter(r => r.id !== id));
    };

    const handleSetStartCurrent = () => {
        setStart(currentTime);
        if (currentTime >= end) {
            setEnd(Math.min(currentTime + 10, duration));
        }
    };

    const handleSetEndCurrent = () => {
        if (currentTime > start) {
            setEnd(currentTime);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center space-x-4">
                <label className="text-sm font-medium text-slate-600 dark:text-slate-300 w-24">
                    {t('rangeSelector.label')}
                </label>
                
                <div className="flex-1 space-y-4">
                    <div className="flex items-end gap-3 p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
                        <div className="flex-1 space-y-1">
                            <label className="text-xs text-slate-500 font-medium">{t('rangeSelector.startTime')}</label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={formatTime(start)}
                                    readOnly
                                    className="w-full px-3 py-2 text-center rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 font-mono text-sm"
                                />
                                <button
                                    onClick={handleSetStartCurrent}
                                    disabled={disabled}
                                    className="px-3 py-2 text-xs font-medium bg-primary-100 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400 rounded-lg hover:bg-primary-200 dark:hover:bg-primary-900/50 transition-colors whitespace-nowrap"
                                >
                                    {t('rangeSelector.setCurrent')}
                                </button>
                            </div>
                        </div>

                        <div className="pb-3 text-slate-400">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                            </svg>
                        </div>

                        <div className="flex-1 space-y-1">
                            <label className="text-xs text-slate-500 font-medium">{t('rangeSelector.endTime')}</label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={formatTime(end)}
                                    readOnly
                                    className="w-full px-3 py-2 text-center rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 font-mono text-sm"
                                />
                                <button
                                    onClick={handleSetEndCurrent}
                                    disabled={disabled}
                                    className="px-3 py-2 text-xs font-medium bg-primary-100 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400 rounded-lg hover:bg-primary-200 dark:hover:bg-primary-900/50 transition-colors whitespace-nowrap"
                                >
                                    {t('rangeSelector.setCurrent')}
                                </button>
                            </div>
                        </div>

                        <button
                            onClick={handleAdd}
                            disabled={disabled || end <= start}
                            className={`
                                h-[38px] px-4 rounded-lg font-medium text-sm text-white shadow-sm transition-all
                                ${end > start 
                                    ? 'bg-primary-500 hover:bg-primary-600 active:scale-95 shadow-primary-500/25' 
                                    : 'bg-slate-300 dark:bg-slate-700 cursor-not-allowed'}
                            `}
                        >
                            {t('rangeSelector.add')}
                        </button>
                    </div>

                    {ranges.length > 0 && (
                        <div className="space-y-2">
                            <div className="text-xs font-medium text-slate-500 uppercase tracking-wider pl-1">
                                {t('rangeSelector.selectedRanges', { count: ranges.length })}
                            </div>
                            <div className="max-h-[200px] overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                                {ranges.map((range, index) => (
                                    <div 
                                        key={range.id}
                                        className="flex items-center justify-between p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 hover:border-primary-200 dark:hover:border-primary-800 transition-colors group"
                                    >
                                        <div className="flex items-center gap-3">
                                            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-slate-100 dark:bg-slate-700 text-xs font-medium text-slate-500 dark:text-slate-400">
                                                {index + 1}
                                            </span>
                                            <div className="flex items-center gap-2 text-sm font-mono text-slate-700 dark:text-slate-300">
                                                <button 
                                                    onClick={() => onSeek(range.start)}
                                                    className="hover:text-primary-500 hover:underline decoration-dashed underline-offset-2"
                                                >
                                                    {formatTime(range.start)}
                                                </button>
                                                <span className="text-slate-400">→</span>
                                                <button 
                                                    onClick={() => onSeek(range.end)}
                                                    className="hover:text-primary-500 hover:underline decoration-dashed underline-offset-2"
                                                >
                                                    {formatTime(range.end)}
                                                </button>
                                            </div>
                                            <div className="text-xs text-slate-400">
                                                ({formatTime(range.end - range.start)})
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button
                                                onClick={() => onSeek(range.start)}
                                                className="p-1.5 text-slate-400 hover:text-primary-500 hover:bg-primary-50 dark:hover:bg-primary-900/30 rounded transition-colors"
                                                title={t('rangeSelector.previewStart')}
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                                </svg>
                                            </button>
                                            <button
                                                onClick={() => handleRemove(range.id)}
                                                className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-colors"
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
                </div>
            </div>
        </div>
    );
};

export default RangeSelector;
