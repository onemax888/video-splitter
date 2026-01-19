import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_LOCALE, MESSAGES, type Locale } from './messages';

const STORAGE_KEY = 'video-splitter.locale';

type Params = Record<string, string | number>;

interface I18nContextValue {
    locale: Locale;
    setLocale: (locale: Locale) => void;
    t: (key: string, params?: Params, fallback?: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
    locale: DEFAULT_LOCALE,
    setLocale: () => {},
    t: (key) => key,
});

const resolveLocale = (): Locale => {
    if (typeof window === 'undefined') {
        return DEFAULT_LOCALE;
    }

    const stored = window.localStorage.getItem(STORAGE_KEY) as Locale | null;
    if (stored === 'zh-CN' || stored === 'en-US') {
        return stored;
    }

    const lang = window.navigator.language?.toLowerCase() || '';
    if (lang.startsWith('zh')) {
        return 'zh-CN';
    }

    return 'en-US';
};

const interpolate = (template: string, params?: Params) => {
    if (!params) {
        return template;
    }
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const value = params[key];
        return value === undefined || value === null ? '' : String(value);
    });
};

export const I18nProvider = ({ children }: { children: ReactNode }) => {
    const [locale, setLocaleState] = useState<Locale>(resolveLocale);

    const setLocale = useCallback((nextLocale: Locale) => {
        setLocaleState(nextLocale);
        if (typeof window !== 'undefined') {
            window.localStorage.setItem(STORAGE_KEY, nextLocale);
        }
    }, []);

    const t = useCallback(
        (key: string, params?: Params, fallback?: string) => {
            const localValue = MESSAGES[locale]?.[key];
            const defaultValue = MESSAGES[DEFAULT_LOCALE]?.[key];
            const template = localValue ?? defaultValue ?? fallback ?? key;
            return interpolate(template, params);
        },
        [locale],
    );

    const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

    return (
        <I18nContext.Provider value={value}>
            {children}
        </I18nContext.Provider>
    );
};

export const useI18n = () => useContext(I18nContext);
