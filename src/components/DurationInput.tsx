import { useI18n } from '../i18n/I18nProvider';

interface DurationInputProps {
    value: number;
    onChange: (value: number) => void;
    unit: 'seconds' | 'minutes';
    onUnitChange: (unit: 'seconds' | 'minutes') => void;
    disabled?: boolean;
}

const PRESETS = [
    { labelValue: 30, value: 30, unit: 'seconds' as const },
    { labelValue: 1, value: 60, unit: 'minutes' as const },
    { labelValue: 5, value: 300, unit: 'minutes' as const },
    { labelValue: 10, value: 600, unit: 'minutes' as const },
    { labelValue: 30, value: 1800, unit: 'minutes' as const },
];

const DurationInput = ({
    value,
    onChange,
    unit,
    onUnitChange,
    disabled = false,
}: DurationInputProps) => {
    const { t } = useI18n();
    const displayValue = unit === 'minutes' ? Math.floor(value / 60) : value;

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const inputValue = parseInt(e.target.value) || 0;
        const seconds = unit === 'minutes' ? inputValue * 60 : inputValue;
        onChange(Math.max(1, seconds));
    };

    const handlePresetClick = (presetValue: number) => {
        if (disabled) return;
        onChange(presetValue);
        onUnitChange('seconds');
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center space-x-4">
                <label className="text-sm font-medium text-slate-600 dark:text-slate-300 w-24">
                    {t('durationInput.label')}
                </label>
                <div className="flex items-center space-x-2">
                    <input
                        type="number"
                        min={1}
                        value={displayValue}
                        onChange={handleInputChange}
                        disabled={disabled}
                        className={`
              w-24 px-3 py-2 rounded-lg 
              bg-white dark:bg-slate-800 
              border border-slate-300 dark:border-slate-600
              text-slate-900 dark:text-white text-center font-medium
              focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent
              transition-all duration-200
              ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
            `}
                    />
                    <div className="flex rounded-lg overflow-hidden border border-slate-300 dark:border-slate-600">
                        <button
                            onClick={() => onUnitChange('seconds')}
                            disabled={disabled}
                            className={`
                px-3 py-2 text-sm font-medium transition-all duration-200
                ${unit === 'seconds'
                                    ? 'bg-primary-600 text-white'
                                    : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                                }
                ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
              `}
                        >
                            {t('common.seconds')}
                        </button>
                        <button
                            onClick={() => onUnitChange('minutes')}
                            disabled={disabled}
                            className={`
                px-3 py-2 text-sm font-medium transition-all duration-200
                ${unit === 'minutes'
                                    ? 'bg-primary-600 text-white'
                                    : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                                }
                ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
              `}
                        >
                            {t('common.minutes')}
                        </button>
                    </div>
                </div>
            </div>

            {/* Presets */}
            <div className="flex items-center space-x-2">
                <span className="text-xs text-slate-500 dark:text-slate-500 w-24">{t('durationInput.presets')}</span>
                <div className="flex flex-wrap gap-2">
                    {PRESETS.map((preset) => {
                        const labelKey = preset.unit === 'seconds'
                            ? 'durationInput.presetSeconds'
                            : 'durationInput.presetMinutes';
                        const label = t(labelKey, { value: preset.labelValue });
                        return (
                        <button
                            key={`${preset.unit}-${preset.labelValue}`}
                            onClick={() => handlePresetClick(preset.value)}
                            disabled={disabled}
                            className={`
                px-3 py-1.5 text-xs font-medium rounded-full
                transition-all duration-200
                ${value === preset.value
                                    ? 'bg-primary-600 text-white'
                                    : 'bg-slate-100 dark:bg-slate-700/50 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white'
                                }
                                ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
              `}
                        >
                            {label}
                        </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export default DurationInput;
