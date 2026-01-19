import { open } from '@tauri-apps/plugin-dialog';
import { useI18n } from '../i18n/I18nProvider';

interface OutputSelectorProps {
    value: string;
    onChange: (path: string) => void;
    disabled?: boolean;
}

const OutputSelector = ({
    value,
    onChange,
    disabled = false,
}: OutputSelectorProps) => {
    const { t } = useI18n();
    const handleClick = async () => {
        if (disabled) return;

        const selected = await open({
            directory: true,
            multiple: false,
        });

        if (selected && typeof selected === 'string') {
            onChange(selected);
        }
    };

    const displayPath = value || t('outputSelector.placeholder');
    const truncatedPath = value
        ? value.length > 40
            ? '...' + value.slice(-40)
            : value
        : displayPath;

    return (
        <div className="flex items-center space-x-4">
            <label className="text-sm font-medium text-slate-600 dark:text-slate-300 w-24">
                {t('outputSelector.label')}
            </label>
            <div className="flex-1 flex items-center space-x-2">
                <div
                    className={`
            flex-1 px-3 py-2 rounded-lg 
            bg-slate-50 dark:bg-slate-800/50 
            border border-slate-200 dark:border-slate-600
            text-sm truncate
            ${value ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500'}
          `}
                    title={value}
                >
                    {truncatedPath}
                </div>
                <button
                    onClick={handleClick}
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
                    {t('outputSelector.select')}
                </button>
            </div>
        </div>
    );
};

export default OutputSelector;
