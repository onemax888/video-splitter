import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useTheme } from '../contexts/ThemeContext';
import { Locale } from '../i18n/messages';
import { useI18n } from '../i18n/I18nProvider';
import { ProxyConfigInfo, ProxyNodeDelay, ProxyOptions } from '../hooks/useRemoteDownload';

interface AppSettingsMenuProps {
    disabled?: boolean;
    onProxyOptionsChange: (options: ProxyOptions | null) => void;
}

const PROXY_CONFIG_STORAGE_KEY = 'video-splitter.proxy-config';
const PROXY_ENABLED_STORAGE_KEY = 'video-splitter.proxy-enabled';
const PROXY_NODE_STORAGE_KEY = 'video-splitter.proxy-node';

const AppSettingsMenu = ({
    disabled = false,
    onProxyOptionsChange,
}: AppSettingsMenuProps) => {
    const { theme, setTheme } = useTheme();
    const { locale, setLocale, t } = useI18n();
    const [openMenu, setOpenMenu] = useState(false);
    const [proxyUrl, setProxyUrl] = useState('');
    const [proxyEnabled, setProxyEnabled] = useState(() => (
        typeof window === 'undefined'
            ? false
            : window.localStorage.getItem(PROXY_ENABLED_STORAGE_KEY) === 'true'
    ));
    const [isImportingProxy, setIsImportingProxy] = useState(false);
    const [isMeasuringProxy, setIsMeasuringProxy] = useState(false);
    const [proxyDelays, setProxyDelays] = useState<Record<string, ProxyNodeDelay>>({});
    const [proxyError, setProxyError] = useState<string | null>(null);
    const [proxyConfig, setProxyConfig] = useState<ProxyConfigInfo | null>(() => {
        if (typeof window === 'undefined') return null;
        const saved = window.localStorage.getItem(PROXY_CONFIG_STORAGE_KEY);
        if (!saved) return null;
        try {
            return JSON.parse(saved) as ProxyConfigInfo;
        } catch {
            return null;
        }
    });
    const [selectedProxyNode, setSelectedProxyNode] = useState(() => {
        if (typeof window === 'undefined') return '';
        const savedNode = window.localStorage.getItem(PROXY_NODE_STORAGE_KEY);
        if (savedNode) return savedNode;
        const saved = window.localStorage.getItem(PROXY_CONFIG_STORAGE_KEY);
        if (!saved) return '';
        try {
            const parsed = JSON.parse(saved) as ProxyConfigInfo;
            return parsed.defaultNode || parsed.nodes?.[0] || '';
        } catch {
            return '';
        }
    });

    const proxyOptions = useMemo<ProxyOptions | null>(() => {
        if (!proxyEnabled) {
            return null;
        }
        return {
            enabled: true,
            configPath: proxyConfig?.configPath || null,
            nodeName: selectedProxyNode || proxyConfig?.defaultNode || null,
        };
    }, [proxyConfig, proxyEnabled, selectedProxyNode]);

    useEffect(() => {
        onProxyOptionsChange(proxyOptions);
    }, [onProxyOptionsChange, proxyOptions]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        window.localStorage.setItem(PROXY_ENABLED_STORAGE_KEY, String(proxyEnabled));
    }, [proxyEnabled]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        if (selectedProxyNode) {
            window.localStorage.setItem(PROXY_NODE_STORAGE_KEY, selectedProxyNode);
        } else {
            window.localStorage.removeItem(PROXY_NODE_STORAGE_KEY);
        }
    }, [selectedProxyNode]);

    const persistProxyConfig = (info: ProxyConfigInfo) => {
        setProxyConfig(info);
        const nextNode = info.defaultNode || info.nodes[0] || '';
        setSelectedProxyNode(nextNode);
        setProxyEnabled(true);
        setProxyDelays({});
        window.localStorage.setItem(PROXY_CONFIG_STORAGE_KEY, JSON.stringify(info));
    };

    const handleImportProxyUrl = async () => {
        const trimmed = proxyUrl.trim();
        if (!trimmed || isImportingProxy || disabled) {
            return;
        }
        setIsImportingProxy(true);
        setProxyError(null);
        try {
            const info = await invoke<ProxyConfigInfo>('import_proxy_config_url_command', {
                url: trimmed,
            });
            persistProxyConfig(info);
        } catch (err) {
            setProxyError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsImportingProxy(false);
        }
    };

    const handleImportProxyFile = async () => {
        if (isImportingProxy || disabled) {
            return;
        }
        const selected = await open({
            multiple: false,
            filters: [
                {
                    name: t('settings.proxy.configFile'),
                    extensions: ['yaml', 'yml'],
                },
            ],
        });
        if (!selected || typeof selected !== 'string') {
            return;
        }
        setIsImportingProxy(true);
        setProxyError(null);
        try {
            const info = await invoke<ProxyConfigInfo>('import_proxy_config_file_command', {
                path: selected,
            });
            persistProxyConfig(info);
        } catch (err) {
            setProxyError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsImportingProxy(false);
        }
    };

    const handleMeasureProxyDelays = async () => {
        if (!proxyConfig?.configPath || isMeasuringProxy || disabled) {
            return;
        }
        setIsMeasuringProxy(true);
        setProxyError(null);
        try {
            const results = await invoke<ProxyNodeDelay[]>('measure_proxy_node_delays_command', {
                configPath: proxyConfig.configPath,
            });
            setProxyDelays(Object.fromEntries(results.map((item) => [item.name, item])));
        } catch (err) {
            setProxyError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsMeasuringProxy(false);
        }
    };

    const formatProxyNodeLabel = (node: string) => {
        const delay = proxyDelays[node];
        if (!delay) {
            return node;
        }
        if (typeof delay.delayMs === 'number') {
            return `${node} · ${delay.delayMs}ms`;
        }
        return `${node} · ${t('settings.proxy.timeout')}`;
    };

    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setOpenMenu((value) => !value)}
                className="rounded-xl bg-slate-200 p-2 text-slate-600 transition-colors hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                title={t('settings.title')}
            >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.607 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
            </button>

            {openMenu && (
                <div className="absolute right-0 z-30 mt-3 w-[min(92vw,32rem)] rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-2xl dark:border-slate-700 dark:bg-slate-900">
                    <div className="mb-4 flex items-center justify-between">
                        <h2 className="font-semibold text-slate-800 dark:text-slate-100">{t('settings.title')}</h2>
                        <button
                            type="button"
                            onClick={() => setOpenMenu(false)}
                            className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                        >
                            {t('common.close')}
                        </button>
                    </div>

                    <div className="space-y-4">
                        <section className="space-y-2">
                            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                                {t('settings.appearance')}
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {(['light', 'dark'] as const).map((item) => (
                                    <button
                                        key={item}
                                        type="button"
                                        onClick={() => setTheme(item)}
                                        className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${theme === item
                                            ? 'bg-primary-600 text-white'
                                            : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                                            }`}
                                    >
                                        {t(`settings.theme.${item}`)}
                                    </button>
                                ))}
                                {(['zh-CN', 'en-US'] as Locale[]).map((item) => (
                                    <button
                                        key={item}
                                        type="button"
                                        onClick={() => setLocale(item)}
                                        className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${locale === item
                                            ? 'bg-primary-600 text-white'
                                            : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                                            }`}
                                    >
                                        {t(`settings.locale.${item}`)}
                                    </button>
                                ))}
                            </div>
                        </section>

                        <section className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-700">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                                    <input
                                        type="checkbox"
                                        checked={proxyEnabled}
                                        onChange={(event) => setProxyEnabled(event.target.checked)}
                                        disabled={disabled}
                                        className="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                                    />
                                    {t('settings.proxy.enable')}
                                </label>
                                {proxyConfig && (
                                    <span className="max-w-full truncate text-xs text-slate-500 dark:text-slate-400" title={proxyConfig.configPath}>
                                        {t('settings.proxy.loaded', { count: proxyConfig.nodes.length })}
                                    </span>
                                )}
                            </div>

                            <div className="flex gap-2">
                                <input
                                    value={proxyUrl}
                                    onChange={(event) => setProxyUrl(event.target.value)}
                                    disabled={disabled || isImportingProxy}
                                    placeholder={t('settings.proxy.urlPlaceholder')}
                                    className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                                />
                                <button
                                    type="button"
                                    onClick={handleImportProxyUrl}
                                    disabled={!proxyUrl.trim() || disabled || isImportingProxy}
                                    className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                                >
                                    {isImportingProxy ? t('settings.proxy.importing') : t('settings.proxy.importUrl')}
                                </button>
                                <button
                                    type="button"
                                    onClick={handleImportProxyFile}
                                    disabled={disabled || isImportingProxy}
                                    className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                                >
                                    {t('settings.proxy.importFile')}
                                </button>
                            </div>

                            <div className="flex items-center gap-2">
                                <select
                                    value={selectedProxyNode}
                                    onChange={(event) => setSelectedProxyNode(event.target.value)}
                                    disabled={disabled || isMeasuringProxy || !proxyConfig?.nodes.length}
                                    className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                                >
                                    {!proxyConfig?.nodes.length && (
                                        <option value="">{t('settings.proxy.noNodes')}</option>
                                    )}
                                    {proxyConfig?.nodes.map((node) => (
                                        <option key={node} value={node}>
                                            {formatProxyNodeLabel(node)}
                                        </option>
                                    ))}
                                </select>
                                <button
                                    type="button"
                                    onClick={handleMeasureProxyDelays}
                                    disabled={disabled || isImportingProxy || isMeasuringProxy || !proxyConfig?.nodes.length}
                                    className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                                >
                                    {isMeasuringProxy ? t('settings.proxy.measuring') : t('settings.proxy.measure')}
                                </button>
                            </div>

                            {proxyError && (
                                <p className="text-xs text-red-500 dark:text-red-400">
                                    {proxyError}
                                </p>
                            )}
                        </section>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AppSettingsMenu;
