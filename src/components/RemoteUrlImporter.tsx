import { FormEvent, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
    DownloadProvider,
    DownloadQuality,
    ProxyConfigInfo,
    ProxyNodeDelay,
    ProxyOptions,
    RemoteDownloadProgress,
} from '../hooks/useRemoteDownload';
import { useI18n } from '../i18n/I18nProvider';

interface RemoteUrlImporterProps {
    disabled?: boolean;
    isDownloading: boolean;
    progress: RemoteDownloadProgress | null;
    onDownload: (
        url: string,
        provider: DownloadProvider,
        quality: DownloadQuality,
        downloadDir: string | null,
        proxyOptions: ProxyOptions | null,
    ) => Promise<void>;
}

const PROVIDERS: DownloadProvider[] = ['auto', 'meowload', 'onccg'];
const QUALITIES: DownloadQuality[] = ['lowest', 'best'];
const DOWNLOAD_DIR_STORAGE_KEY = 'video-splitter.remote-download-dir';
const PROXY_CONFIG_STORAGE_KEY = 'video-splitter.proxy-config';

const formatBytes = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(0)} KB`;
    }
    return `${bytes} B`;
};

const RemoteUrlImporter = ({
    disabled = false,
    isDownloading,
    progress,
    onDownload,
}: RemoteUrlImporterProps) => {
    const { t } = useI18n();
    const [url, setUrl] = useState('');
    const [provider, setProvider] = useState<DownloadProvider>('auto');
    const [quality, setQuality] = useState<DownloadQuality>('lowest');
    const [downloadDir, setDownloadDir] = useState(() => (
        typeof window === 'undefined'
            ? ''
            : window.localStorage.getItem(DOWNLOAD_DIR_STORAGE_KEY) || ''
    ));
    const [proxyUrl, setProxyUrl] = useState('');
    const [useOnccgProxy, setUseOnccgProxy] = useState(false);
    const [isImportingProxy, setIsImportingProxy] = useState(false);
    const [isMeasuringProxy, setIsMeasuringProxy] = useState(false);
    const [proxyDelays, setProxyDelays] = useState<Record<string, ProxyNodeDelay>>({});
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
        const saved = window.localStorage.getItem(PROXY_CONFIG_STORAGE_KEY);
        if (!saved) return '';
        try {
            const parsed = JSON.parse(saved) as ProxyConfigInfo;
            return parsed.defaultNode || parsed.nodes?.[0] || '';
        } catch {
            return '';
        }
    });
    const [proxyImportError, setProxyImportError] = useState<string | null>(null);

    const canSubmit = useMemo(() => {
        const trimmed = url.trim();
        return /^https?:\/\/\S+$/i.test(trimmed) && !disabled && !isDownloading;
    }, [disabled, isDownloading, url]);

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();
        if (!canSubmit) {
            return;
        }
        await onDownload(
            url.trim(),
            provider,
            quality,
            downloadDir.trim() || null,
            useOnccgProxy
                ? {
                    enabled: true,
                    configPath: proxyConfig?.configPath || null,
                    nodeName: selectedProxyNode || proxyConfig?.defaultNode || null,
                }
                : null,
        );
    };

    const persistProxyConfig = (info: ProxyConfigInfo) => {
        setProxyConfig(info);
        const nextNode = info.defaultNode || info.nodes[0] || '';
        setSelectedProxyNode(nextNode);
        setUseOnccgProxy(true);
        setProxyDelays({});
        window.localStorage.setItem(PROXY_CONFIG_STORAGE_KEY, JSON.stringify(info));
    };

    const handleImportProxyUrl = async () => {
        const trimmed = proxyUrl.trim();
        if (!trimmed || isImportingProxy || disabled || isDownloading) {
            return;
        }
        setIsImportingProxy(true);
        setProxyImportError(null);
        try {
            const info = await invoke<ProxyConfigInfo>('import_proxy_config_url_command', {
                url: trimmed,
            });
            persistProxyConfig(info);
        } catch (err) {
            setProxyImportError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsImportingProxy(false);
        }
    };

    const handleMeasureProxyDelays = async () => {
        if (!proxyConfig?.configPath || isMeasuringProxy || disabled || isDownloading) {
            return;
        }
        setIsMeasuringProxy(true);
        setProxyImportError(null);
        try {
            const results = await invoke<ProxyNodeDelay[]>('measure_proxy_node_delays_command', {
                configPath: proxyConfig.configPath,
            });
            setProxyDelays(Object.fromEntries(results.map((item) => [item.name, item])));
        } catch (err) {
            setProxyImportError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsMeasuringProxy(false);
        }
    };

    const handleImportProxyFile = async () => {
        if (isImportingProxy || disabled || isDownloading) {
            return;
        }
        const selected = await open({
            multiple: false,
            filters: [
                {
                    name: t('remote.proxy.configFile'),
                    extensions: ['yaml', 'yml'],
                },
            ],
        });
        if (!selected || typeof selected !== 'string') {
            return;
        }
        setIsImportingProxy(true);
        setProxyImportError(null);
        try {
            const info = await invoke<ProxyConfigInfo>('import_proxy_config_file_command', {
                path: selected,
            });
            persistProxyConfig(info);
        } catch (err) {
            setProxyImportError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsImportingProxy(false);
        }
    };

    const handleSelectDownloadDir = async () => {
        if (disabled || isDownloading) {
            return;
        }

        const selected = await open({
            directory: true,
            multiple: false,
        });

        if (selected && typeof selected === 'string') {
            setDownloadDir(selected);
            window.localStorage.setItem(DOWNLOAD_DIR_STORAGE_KEY, selected);
        }
    };

    const handleResetDownloadDir = () => {
        setDownloadDir('');
        window.localStorage.removeItem(DOWNLOAD_DIR_STORAGE_KEY);
    };

    const progressText = progress?.totalBytes
        ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
        : progress?.downloadedBytes
            ? formatBytes(progress.downloadedBytes)
            : '';
    const showProxyOptions = provider === 'onccg';
    const displayDir = downloadDir || t('remote.downloadDir.default');
    const truncatedDir = downloadDir && downloadDir.length > 58
        ? `...${downloadDir.slice(-58)}`
        : displayDir;
    const formatProxyNodeLabel = (node: string) => {
        const delay = proxyDelays[node];
        if (!delay) {
            return node;
        }
        if (typeof delay.delayMs === 'number') {
            return `${node} · ${delay.delayMs}ms`;
        }
        return `${node} · ${t('remote.proxy.timeout')}`;
    };

    return (
        <form onSubmit={handleSubmit} className="glass rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
                <label className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                    {t('remote.title')}
                </label>
                <div className="flex items-center gap-2">
                    <select
                        value={provider}
                        onChange={(event) => setProvider(event.target.value as DownloadProvider)}
                        disabled={disabled || isDownloading}
                        className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs text-slate-700 dark:text-slate-200"
                        aria-label={t('remote.provider')}
                    >
                        {PROVIDERS.map((item) => (
                            <option key={item} value={item}>
                                {t(`remote.provider.${item}`)}
                            </option>
                        ))}
                    </select>
                    <select
                        value={quality}
                        onChange={(event) => setQuality(event.target.value as DownloadQuality)}
                        disabled={disabled || isDownloading}
                        className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs text-slate-700 dark:text-slate-200"
                        aria-label={t('remote.quality')}
                    >
                        {QUALITIES.map((item) => (
                            <option key={item} value={item}>
                                {t(`remote.quality.${item}`)}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            <div className="flex gap-2">
                <input
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    disabled={disabled || isDownloading}
                    placeholder={t('remote.placeholder')}
                    className="min-w-0 flex-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                />
                <button
                    type="submit"
                    disabled={!canSubmit}
                    className={`
                        inline-flex min-w-24 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors
                        ${canSubmit
                            ? 'bg-primary-600 text-white hover:bg-primary-500'
                            : 'bg-slate-300 dark:bg-slate-700 text-slate-500 dark:text-slate-400 cursor-not-allowed'
                        }
                    `}
                >
                    {isDownloading && (
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                    )}
                    {isDownloading ? t('remote.downloading') : t('remote.download')}
                </button>
            </div>

            <div className="flex items-center gap-3">
                <label className="w-20 shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                    {t('remote.downloadDir')}
                </label>
                <div
                    className={`
                        min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-slate-600
                        bg-slate-50 dark:bg-slate-800/50 px-3 py-2 text-xs truncate
                        ${downloadDir ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500'}
                    `}
                    title={downloadDir || t('remote.downloadDir.defaultTitle')}
                >
                    {truncatedDir}
                </div>
                {downloadDir && (
                    <button
                        type="button"
                        onClick={handleResetDownloadDir}
                        disabled={disabled || isDownloading}
                        className="rounded-lg px-2 py-2 text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {t('common.clear')}
                    </button>
                )}
                <button
                    type="button"
                    onClick={handleSelectDownloadDir}
                    disabled={disabled || isDownloading}
                    className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                >
                    {t('remote.downloadDir.select')}
                </button>
            </div>

            {showProxyOptions && (
                <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-800/30">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                            <input
                                type="checkbox"
                                checked={useOnccgProxy}
                                onChange={(event) => setUseOnccgProxy(event.target.checked)}
                                disabled={disabled || isDownloading}
                                className="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                            />
                            {t('remote.proxy.enable')}
                        </label>
                        {proxyConfig && (
                            <span className="max-w-full truncate text-xs text-slate-500 dark:text-slate-400" title={proxyConfig.configPath}>
                                {t('remote.proxy.loaded', { count: proxyConfig.nodes.length })}
                            </span>
                        )}
                    </div>

                    <div className="flex gap-2">
                        <input
                            value={proxyUrl}
                            onChange={(event) => setProxyUrl(event.target.value)}
                            disabled={disabled || isDownloading || isImportingProxy}
                            placeholder={t('remote.proxy.urlPlaceholder')}
                            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                        />
                        <button
                            type="button"
                            onClick={handleImportProxyUrl}
                            disabled={!proxyUrl.trim() || disabled || isDownloading || isImportingProxy}
                            className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                        >
                            {isImportingProxy ? t('remote.proxy.importing') : t('remote.proxy.importUrl')}
                        </button>
                        <button
                            type="button"
                            onClick={handleImportProxyFile}
                            disabled={disabled || isDownloading || isImportingProxy}
                            className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                        >
                            {t('remote.proxy.importFile')}
                        </button>
                    </div>

                    <div className="flex items-center gap-3">
                        <label className="w-20 shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                            {t('remote.proxy.node')}
                        </label>
                        <select
                            value={selectedProxyNode}
                            onChange={(event) => setSelectedProxyNode(event.target.value)}
                            disabled={disabled || isDownloading || isMeasuringProxy || !proxyConfig?.nodes.length}
                            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                        >
                            {!proxyConfig?.nodes.length && (
                                <option value="">{t('remote.proxy.noNodes')}</option>
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
                            disabled={disabled || isDownloading || isImportingProxy || isMeasuringProxy || !proxyConfig?.nodes.length}
                            className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                        >
                            {isMeasuringProxy ? t('remote.proxy.measuring') : t('remote.proxy.measure')}
                        </button>
                    </div>

                    {proxyImportError && (
                        <p className="text-xs text-red-500 dark:text-red-400">
                            {proxyImportError}
                        </p>
                    )}
                </div>
            )}

            {progress && (isDownloading || progress.percentage > 0) && (
                <div className="space-y-2">
                    <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                        <div
                            className="h-full rounded-full bg-primary-500 transition-all duration-300"
                            style={{ width: `${Math.min(Math.max(progress.percentage, 2), 100)}%` }}
                        />
                    </div>
                    <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                        <span className="truncate">
                            {t(`remote.stage.${progress.stage}`, undefined, progress.stage)}
                            {progress.currentFile ? ` · ${progress.currentFile}` : ''}
                        </span>
                        <span className="shrink-0">
                            {progressText || `${Math.round(progress.percentage)}%`}
                        </span>
                    </div>
                </div>
            )}
        </form>
    );
};

export default RemoteUrlImporter;
