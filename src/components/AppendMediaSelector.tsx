import { open } from '@tauri-apps/plugin-dialog';
import { AppendSource, AppendKind } from '../types/append';

interface AppendMediaSelectorProps {
    label: string;
    value: AppendSource | null;
    onChange: (value: AppendSource | null) => void;
    disabled?: boolean;
}

const DEFAULT_IMAGE_DURATION = 3;

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v'];
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'bmp', 'webp'];

const AppendMediaSelector = ({
    label,
    value,
    onChange,
    disabled = false,
}: AppendMediaSelectorProps) => {
    const kind = value?.kind ?? 'none';

    const handleKindChange = (next: 'none' | AppendKind) => {
        if (disabled) return;
        if (next === 'none') {
            onChange(null);
            return;
        }
        onChange({
            kind: next,
            path: '',
            durationSeconds: next === 'image' ? DEFAULT_IMAGE_DURATION : undefined,
        });
    };

    const handlePick = async () => {
        if (disabled || kind === 'none') return;

        const selected = await open({
            multiple: false,
            filters: [
                {
                    name: kind === 'image' ? 'Image' : 'Video',
                    extensions: kind === 'image' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS,
                },
            ],
        });

        if (selected && typeof selected === 'string') {
            onChange({
                kind,
                path: selected,
                durationSeconds: kind === 'image' ? value?.durationSeconds ?? DEFAULT_IMAGE_DURATION : undefined,
            });
        }
    };

    const handleClear = () => {
        if (disabled || kind === 'none') return;
        onChange({
            kind,
            path: '',
            durationSeconds: kind === 'image' ? value?.durationSeconds ?? DEFAULT_IMAGE_DURATION : undefined,
        });
    };

    const handleDurationChange = (nextValue: string) => {
        if (disabled || kind !== 'image') return;
        const seconds = Math.max(1, Math.floor(Number(nextValue) || 0));
        onChange({
            kind: 'image',
            path: value?.path ?? '',
            durationSeconds: seconds,
        });
    };

    const pathValue = value?.path ?? '';
    const displayPath = pathValue || '未选择文件';
    const truncatedPath = pathValue
        ? pathValue.length > 40
            ? '...' + pathValue.slice(-40)
            : pathValue
        : displayPath;

    return (
        <div className="space-y-3">
            <div className="flex items-center space-x-4">
                <label className="text-sm font-medium text-slate-600 dark:text-slate-300 w-24">
                    {label}
                </label>
                <div className="flex rounded-lg overflow-hidden border border-slate-300 dark:border-slate-600">
                    <button
                        onClick={() => handleKindChange('none')}
                        disabled={disabled}
                        className={`
                            px-3 py-2 text-sm font-medium transition-all duration-200
                            ${kind === 'none'
                                ? 'bg-primary-600 text-white'
                                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                            }
                            ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                        `}
                    >
                        无
                    </button>
                    <button
                        onClick={() => handleKindChange('image')}
                        disabled={disabled}
                        className={`
                            px-3 py-2 text-sm font-medium transition-all duration-200
                            ${kind === 'image'
                                ? 'bg-primary-600 text-white'
                                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                            }
                            ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                        `}
                    >
                        图片
                    </button>
                    <button
                        onClick={() => handleKindChange('video')}
                        disabled={disabled}
                        className={`
                            px-3 py-2 text-sm font-medium transition-all duration-200
                            ${kind === 'video'
                                ? 'bg-primary-600 text-white'
                                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                            }
                            ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                        `}
                    >
                        视频
                    </button>
                </div>
            </div>

            {kind !== 'none' && (
                <div className="pl-28 space-y-3">
                    <div className="flex items-center space-x-2">
                        <div
                            className={`
                                flex-1 px-3 py-2 rounded-lg 
                                bg-slate-50 dark:bg-slate-800/50 
                                border border-slate-200 dark:border-slate-600
                                text-sm truncate
                                ${value?.path ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500'}
                            `}
                            title={value?.path || ''}
                        >
                            {truncatedPath}
                        </div>
                        <button
                            onClick={handlePick}
                            disabled={disabled}
                            className={`
                                px-4 py-2 rounded-lg 
                                bg-slate-100 dark:bg-slate-700 
                                text-slate-700 dark:text-slate-300
                                hover:bg-slate-200 dark:hover:bg-slate-600 
                                transition-colors text-sm font-medium
                                ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                            `}
                        >
                            选择...
                        </button>
                        <button
                            onClick={handleClear}
                            disabled={disabled || !value?.path}
                            className={`
                                px-3 py-2 rounded-lg 
                                bg-slate-100 dark:bg-slate-700 
                                text-slate-500 dark:text-slate-400
                                hover:bg-slate-200 dark:hover:bg-slate-600 
                                transition-colors text-xs font-medium
                                ${disabled || !value?.path ? 'opacity-50 cursor-not-allowed' : ''}
                            `}
                        >
                            清除
                        </button>
                    </div>

                    {kind === 'image' && (
                        <div className="flex items-center space-x-3">
                            <span className="text-xs text-slate-500 dark:text-slate-400">图片时长(秒)</span>
                            <input
                                type="number"
                                min={1}
                                value={value?.durationSeconds ?? DEFAULT_IMAGE_DURATION}
                                onChange={(e) => handleDurationChange(e.target.value)}
                                disabled={disabled}
                                className={`
                                    w-24 px-3 py-2 rounded-lg 
                                    bg-white dark:bg-slate-800 
                                    border border-slate-300 dark:border-slate-600
                                    text-slate-900 dark:text-white text-center font-medium text-sm
                                    focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent
                                    transition-all duration-200
                                    ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                                `}
                            />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default AppendMediaSelector;
