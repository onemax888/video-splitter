import { useId } from 'react';
import { IntervalSplitMode } from '../types/interval';
import { useI18n } from '../i18n/I18nProvider';

export default function IntervalModeSelector({ value, onChange, hasAppend, disabled = false }: {
    value: IntervalSplitMode; onChange: (mode: IntervalSplitMode) => void; hasAppend: boolean; disabled?: boolean;
}) {
    const { t } = useI18n();
    const id = useId();
    return <div className="space-y-2">
        <div className="flex items-center space-x-4">
            <label htmlFor={id} className="text-sm font-medium text-slate-600 dark:text-slate-300 w-24">{t('interval.modeLabel')}</label>
            <select id={id} value={hasAppend ? 'precise' : value} onChange={e => onChange(e.target.value as IntervalSplitMode)}
                disabled={disabled || hasAppend} aria-describedby={`${id}-description`}
                className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-white disabled:opacity-50">
                <option value="copy">{t('interval.copy')}</option><option value="precise">{t('interval.precise')}</option>
            </select>
        </div>
        <p id={`${id}-description`} className="text-xs text-slate-500 dark:text-slate-400 pl-28">
            {t(hasAppend ? 'interval.appendDesc' : value === 'precise' ? 'interval.preciseDesc' : 'interval.copyDesc')}
        </p>
    </div>;
}
