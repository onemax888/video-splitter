import { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';

interface Range {
  start: number;
  end: number;
}

interface RangeEditorProps {
  currentTime: number;
  duration: number;
  ranges: Range[];
  onAddRange: (range: Range) => void;
  onDeleteRange: (index: number) => void;
  onSeek: (time: number) => void;
  disabled?: boolean;
}

const formatTime = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  
  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
};

const RangeEditor = ({
  currentTime,
  duration,
  ranges,
  onAddRange,
  onDeleteRange,
  onSeek,
  disabled = false
}: RangeEditorProps) => {
  const { t } = useI18n();
  const [start, setStart] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);

  // Auto-fill start/end if they are null, just for better UX? 
  // No, let's keep them explicit.

  const handleSetStart = () => {
    setStart(currentTime);
    // If end is set and less than new start, clear end
    if (end !== null && end <= currentTime) {
      setEnd(null);
    }
  };

  const handleSetEnd = () => {
    // End must be greater than start
    if (start !== null && currentTime <= start) {
      return; 
    }
    setEnd(currentTime);
  };

  const handleAdd = () => {
    if (start !== null && end !== null) {
      onAddRange({ start, end });
      setStart(null);
      setEnd(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <label className="text-sm font-medium text-slate-600 dark:text-slate-300 w-24">
          {t('rangeEditor.label')}
        </label>
        
        <div className="flex-1 space-y-4">
          {/* Controls */}
          <div className="flex items-center gap-3">
             <div className="flex flex-col gap-1">
                <span className="text-xs text-slate-500 uppercase font-bold">{t('rangeEditor.startTime')}</span>
                <div className="flex items-center gap-2">
                    <div className="px-3 py-2 bg-slate-100 dark:bg-slate-800 rounded-lg font-mono text-sm border border-slate-200 dark:border-slate-700 min-w-[100px] text-center">
                        {start !== null ? formatTime(start) : '--:--:--'}
                    </div>
                    <button
                        onClick={handleSetStart}
                        disabled={disabled}
                        className="px-3 py-2 bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50 rounded-lg text-xs font-medium transition-colors"
                    >
                        {t('rangeEditor.setCurrent')}
                    </button>
                </div>
             </div>

             <div className="h-8 w-px bg-slate-300 dark:bg-slate-700 mx-2"></div>

             <div className="flex flex-col gap-1">
                <span className="text-xs text-slate-500 uppercase font-bold">{t('rangeEditor.endTime')}</span>
                <div className="flex items-center gap-2">
                    <div className="px-3 py-2 bg-slate-100 dark:bg-slate-800 rounded-lg font-mono text-sm border border-slate-200 dark:border-slate-700 min-w-[100px] text-center">
                        {end !== null ? formatTime(end) : '--:--:--'}
                    </div>
                    <button
                        onClick={handleSetEnd}
                        disabled={disabled || (start !== null && currentTime <= start)}
                        className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                             disabled || (start !== null && currentTime <= start)
                             ? 'bg-slate-100 text-slate-400 cursor-not-allowed dark:bg-slate-800 dark:text-slate-600'
                             : 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50'
                        }`}
                    >
                        {t('rangeEditor.setCurrent')}
                    </button>
                </div>
             </div>

             <div className="flex-1"></div>

             <button
                onClick={handleAdd}
                disabled={disabled || start === null || end === null}
                className={`
                    h-10 px-6 rounded-lg font-medium text-sm flex items-center gap-2 transition-all shadow-sm
                    ${disabled || start === null || end === null
                        ? 'bg-slate-200 text-slate-400 cursor-not-allowed dark:bg-slate-700 dark:text-slate-500' 
                        : 'bg-primary-600 hover:bg-primary-500 text-white shadow-primary-500/20 active:scale-95'}
                `}
             >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                {t('rangeEditor.addSegment')}
             </button>
          </div>

          {/* Range List */}
          {ranges.length > 0 && (
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1 custom-scrollbar">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">{t('rangeEditor.addedSegments', { count: ranges.length })}</div>
                {ranges.map((range, index) => (
                    <div 
                        key={index}
                        className="group flex items-center justify-between p-3 rounded-lg bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 hover:border-primary-300 dark:hover:border-primary-700/50 transition-all"
                    >
                        <div className="flex items-center gap-4">
                            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-slate-100 dark:bg-slate-700 text-xs font-medium text-slate-500 dark:text-slate-400">
                                {index + 1}
                            </span>
                            <div className="flex items-center gap-2 font-mono text-sm text-slate-700 dark:text-slate-300">
                                <span className="text-green-600 dark:text-green-400">{formatTime(range.start)}</span>
                                <span className="text-slate-400">→</span>
                                <span className="text-red-500 dark:text-red-400">{formatTime(range.end)}</span>
                                <span className="text-xs text-slate-400 ml-2">
                                    ({formatTime(range.end - range.start)})
                                </span>
                            </div>
                        </div>
                        
                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                                onClick={() => onSeek(range.start)}
                                className="p-1.5 text-slate-400 hover:text-primary-500 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded-md transition-colors"
                                title={t('rangeEditor.jumpToStart')}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                            </button>
                            <button
                                onClick={() => onDeleteRange(index)}
                                className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors"
                                title={t('rangeEditor.deleteSegment')}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                            </button>
                        </div>
                    </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default RangeEditor;
