import { useI18n } from '../i18n/I18nProvider';

interface SplitModeSelectorProps {
    mode: 'interval' | 'ranges';
    onChange: (mode: 'interval' | 'ranges') => void;
    disabled?: boolean;
}

const SplitModeSelector = ({ mode, onChange, disabled = false }: SplitModeSelectorProps) => {
    const { t } = useI18n();
    return (
        <div className="flex items-center justify-center gap-2">
            <span className="text-sm font-medium text-slate-600 dark:text-slate-300">{t('splitMode.label')}</span>
            <div className="flex rounded-lg overflow-hidden border border-slate-300 dark:border-slate-600">
                <button
                    onClick={() => onChange('ranges')}
                    disabled={disabled}
                    className={`
                        px-4 py-2 text-sm font-medium transition-all duration-200
                        ${mode === 'ranges'
                            ? 'bg-primary-600 text-white'
                            : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                        }
                        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                    `}
                >
                    {t('splitMode.ranges')}
                </button>
                <button
                    onClick={() => onChange('interval')}
                    disabled={disabled}
                    className={`
                        px-4 py-2 text-sm font-medium transition-all duration-200
                        ${mode === 'interval'
                            ? 'bg-primary-600 text-white'
                            : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                        }
                        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                    `}
                >
                    {t('splitMode.interval')}
                </button>
            </div>
        </div>
    );
};

export default SplitModeSelector;
