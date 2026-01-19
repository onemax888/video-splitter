import { useI18n } from '../i18n/I18nProvider';

const LanguageToggle = () => {
    const { locale, setLocale, t } = useI18n();

    return (
        <div className="flex items-center gap-1 rounded-lg bg-slate-200 dark:bg-slate-700 p-0.5 text-xs">
            <button
                onClick={() => setLocale('zh-CN')}
                className={`px-2 py-1 rounded-md transition-colors ${locale === 'zh-CN'
                    ? 'bg-white text-slate-700 dark:bg-slate-900 dark:text-slate-200'
                    : 'text-slate-500 dark:text-slate-300 hover:text-slate-700 dark:hover:text-slate-100'
                    }`}
            >
                {t('language.zh')}
            </button>
            <button
                onClick={() => setLocale('en-US')}
                className={`px-2 py-1 rounded-md transition-colors ${locale === 'en-US'
                    ? 'bg-white text-slate-700 dark:bg-slate-900 dark:text-slate-200'
                    : 'text-slate-500 dark:text-slate-300 hover:text-slate-700 dark:hover:text-slate-100'
                    }`}
            >
                {t('language.en')}
            </button>
        </div>
    );
};

export default LanguageToggle;
