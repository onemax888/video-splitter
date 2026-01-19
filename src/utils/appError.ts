import { AppError } from '../types/error';

const isObject = (value: unknown): value is Record<string, unknown> => (
    !!value && typeof value === 'object'
);

export const isAppError = (value: unknown): value is AppError => (
    isObject(value) && typeof value.code === 'string'
);

const parseJsonError = (value: string): AppError | null => {
    try {
        const parsed = JSON.parse(value);
        return isAppError(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

export const toAppError = (err: unknown): AppError => {
    if (isAppError(err)) {
        return err;
    }

    if (err instanceof Error) {
        const parsed = parseJsonError(err.message);
        if (parsed) {
            return parsed;
        }
        return { code: 'UNKNOWN', message: err.message };
    }

    if (typeof err === 'string') {
        const parsed = parseJsonError(err);
        if (parsed) {
            return parsed;
        }
        return { code: 'UNKNOWN', message: err };
    }

    if (isObject(err)) {
        if (typeof err.message === 'string') {
            const parsed = parseJsonError(err.message);
            if (parsed) {
                return parsed;
            }
        }
        const code = typeof err.code === 'string' ? err.code : 'UNKNOWN';
        const message = typeof err.message === 'string' ? err.message : undefined;
        const detail = typeof err.detail === 'string' ? err.detail : undefined;
        return { code, message, detail };
    }

    return { code: 'UNKNOWN', message: String(err) };
};

export const formatAppError = (
    error: AppError | null | undefined,
    t: (key: string, params?: Record<string, string | number>, fallback?: string) => string,
) => {
    if (!error) {
        return t('errors.UNKNOWN');
    }

    const key = `errors.${error.code}`;
    const localized = t(key);
    if (localized !== key) {
        return localized;
    }

    return error.message || error.detail || t('errors.UNKNOWN');
};
