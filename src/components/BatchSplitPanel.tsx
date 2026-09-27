import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useI18n } from '../i18n/I18nProvider';
import { AppendSource } from '../types/append';
import { IntervalSplitMode } from '../types/interval';
import FileDropZone from './FileDropZone';
import DurationInput from './DurationInput';
import IntervalModeSelector from './IntervalModeSelector';
import AppendMediaSelector from './AppendMediaSelector';
import OutputSelector from './OutputSelector';
import ResultList from './ResultList';
import { formatAppError, toAppError } from '../utils/appError';

interface QueueItem { path: string; duration?: number; error?: string; }
interface BatchItem { input_path: string; status: string; output_files: string[]; error: string | null; }
interface BatchResult {
    job_id: string; output_dir: string; items: BatchItem[]; current_index: number | null;
    status: string; error: string | null; total_elapsed_ms: number;
}
interface SegmentProgress { job_id: string; progress: { percentage: number; current_segment: number; total_segments: number }; }
const filename = (path: string) => path.split(/[\\/]/).pop() || path;
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const button = 'px-3 py-2 rounded-lg text-sm bg-slate-100 dark:bg-slate-700 disabled:opacity-40 hover:bg-slate-200 dark:hover:bg-slate-600';
const appendReady = (source: AppendSource | null) => !source || !!source.path && (source.kind !== 'image' || !!source.durationSeconds && source.durationSeconds > 0);

export default function BatchSplitPanel({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
    const { t } = useI18n();
    const [queue, setQueue] = useState<QueueItem[]>([]);
    const [duration, setDuration] = useState(8);
    const [unit, setUnit] = useState<'seconds' | 'minutes'>('seconds');
    const [mode, setMode] = useState<IntervalSplitMode>('copy');
    const [layout, setLayout] = useState<'perVideo' | 'together'>('perVideo');
    const [intro, setIntro] = useState<AppendSource | null>(null);
    const [outro, setOutro] = useState<AppendSource | null>(null);
    const [output, setOutput] = useState('');
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [result, setResult] = useState<BatchResult | null>(null);
    const [segment, setSegment] = useState<SegmentProgress['progress'] | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [elapsed, setElapsed] = useState(0);
    const errorText = (value: unknown) => {
        const parsed = toAppError(value);
        const message = parsed.code === 'UNKNOWN' ? parsed.message || parsed.detail || formatAppError(parsed, t) : formatAppError(parsed, t);
        return parsed.detail && parsed.detail !== message ? `${message}\n${parsed.detail}` : message;
    };
    const active = useRef<string | null>(null);
    const importing = useRef(false);
    const alive = useRef(true);
    const resultRef = useRef<BatchResult | null>(null);
    const locked = busy || loading;
    const hasAppend = !!intro?.path || !!outro?.path;

    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    useEffect(() => { onBusyChange(locked); return () => onBusyChange(false); }, [locked, onBusyChange]);
    useEffect(() => {
        if (!busy) return;
        const start = Date.now();
        const timer = window.setInterval(() => setElapsed(Date.now() - start), 1000);
        return () => window.clearInterval(timer);
    }, [busy]);

    const addFiles = useCallback(async (paths: string[]) => {
        if (active.current || importing.current) return;
        importing.current = true;
        setLoading(true); setError(''); setNotice(''); setResult(null);
        const existing = new Set(queue.map(q => q.path));
        const supported = paths.filter(path => /\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v)$/i.test(path));
        const unique = [...new Set(supported)].filter(path => !existing.has(path)).sort((a, b) => natural.compare(filename(a), filename(b)) || natural.compare(a, b));
        if (unique.length < paths.length) setNotice(t('batch.ignored', { count: paths.length - unique.length }));
        // Probe serially rather than starting hundreds of FFprobe processes on import.
        const items: QueueItem[] = [];
        for (const path of unique) {
            try {
                const info = await invoke<{ duration: number }>('get_video_info', { path });
                items.push({ path, duration: info.duration });
            } catch (e) { items.push({ path, error: errorText(e) }); }
            if (!alive.current) break;
        }
        if (alive.current) {
            setQueue(previous => [...previous, ...items]);
            if (!output && unique.length) setOutput(unique[0].replace(/[\\/][^\\/]+$/, ''));
            setLoading(false);
        }
        importing.current = false;
    }, [queue, output, t]);

    const move = (index: number, delta: number) => {
        setResult(null);
        setQueue(previous => { const next = [...previous]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next; });
    };

    const start = async (paths = queue.map(q => q.path)) => {
        if (active.current || !paths.length) return;
        const jobId = crypto.randomUUID();
        active.current = jobId;
        setBusy(true); setStopping(false); setError(''); setResult(null); setSegment(null); setElapsed(0);
        resultRef.current = null;
        const unlisten: (() => void)[] = [];
        try {
            // Register before invoking so even a stream-copy job cannot outrun its listeners.
            unlisten.push(await listen<BatchResult>('batch-progress', event => {
                if (event.payload.job_id !== active.current) return;
                if (resultRef.current?.current_index !== event.payload.current_index) setSegment(null);
                resultRef.current = event.payload; setResult(event.payload);
            }));
            unlisten.push(await listen<SegmentProgress>('batch-segment-progress', event => {
                if (event.payload.job_id === active.current) setSegment(event.payload.progress);
            }));
            const finished = await invoke<BatchResult>('batch_split', { request: {
                jobId, paths, outputDir: output, layout, segmentDuration: duration, intervalMode: mode, intro, outro,
            } });
            setResult(finished); setElapsed(finished.total_elapsed_ms);
        } catch (e) { setError(errorText(e)); }
        finally { unlisten.forEach(fn => fn()); active.current = null; setBusy(false); setStopping(false); }
    };

    const stop = async () => {
        if (!active.current) return;
        setStopping(true);
        try { await invoke('stop_batch_split', { jobId: active.current }); }
        catch (e) { setError(errorText(e)); setStopping(false); }
    };
    const openFolder = async (path: string) => { try { await revealItemInDir(`${path}/切分清单.csv`); } catch (e) { setError(errorText(e)); } };
    const succeeded = result?.items.filter(i => i.status === 'success').length || 0;
    const failed = result?.items.filter(i => i.status === 'failed') || [];
    const completed = succeeded + failed.length;
    const ready = queue.length > 0 && !!output && Number.isSafeInteger(duration) && duration > 0 && duration <= 4294967295 && appendReady(intro) && appendReady(outro) && !locked;

    return <div className="space-y-6">
        <p className="text-sm text-slate-500">{t('batch.description')}</p>
        <FileDropZone multiple onFilesSelect={addFiles} onFileSelect={path => addFiles([path])} selectedFile={null} videoInfo={null} disabled={locked} />
        {loading && <p role="status">{t('batch.loading')}</p>}
        {notice && <p className="text-sm text-amber-600" role="status">{notice}</p>}
        {queue.length > 0 && <section className="glass rounded-xl p-4 space-y-3" aria-label={t('batch.queue')}>
            <div className="flex items-center justify-between"><b>{t('batch.queue')} · {queue.length}</b>
                <button className={button} disabled={locked} onClick={() => { setQueue([]); setResult(null); }}>{t('batch.clear')}</button></div>
            <ol className="max-h-64 overflow-auto space-y-2">
                {queue.map((item, index) => <li key={item.path} className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-800 p-2">
                    <span className="text-xs text-slate-500">{String(index + 1).padStart(3, '0')}</span>
                    <div className="min-w-0 flex-1"><p className="truncate text-sm" title={item.path}>{filename(item.path)}</p>
                        <p className="text-xs text-slate-500">{item.duration !== undefined ? t('batch.duration', { seconds: item.duration.toFixed(1) }) : t('batch.probeFailed')}</p>
                        {item.error && <details className="text-xs text-red-500"><summary>{t('app.errorDetails')}</summary><p className="whitespace-pre-wrap break-all">{item.error}</p></details>}
                    </div>
                    <button className={button} disabled={locked || index === 0} aria-label={t('batch.up')} onClick={() => move(index, -1)}>↑</button>
                    <button className={button} disabled={locked || index === queue.length - 1} aria-label={t('batch.down')} onClick={() => move(index, 1)}>↓</button>
                    <button className={button} disabled={locked} aria-label={t('batch.remove')} onClick={() => { setQueue(q => q.filter(x => x.path !== item.path)); setResult(null); }}>×</button>
                </li>)}
            </ol>
            <p className="text-xs text-slate-500">{t('batch.orderHint')}</p>
        </section>}
        <section className="glass rounded-xl p-5 space-y-5" aria-label={t('batch.settings')}>
            <h2 className="font-medium">{t('batch.settings')}</h2>
            <DurationInput value={duration} onChange={setDuration} unit={unit} onUnitChange={setUnit} disabled={locked} />
            <IntervalModeSelector value={mode} onChange={setMode} hasAppend={hasAppend} disabled={locked} />
            <AppendMediaSelector label={t('append.intro')} value={intro} onChange={setIntro} disabled={locked} />
            <AppendMediaSelector label={t('append.outro')} value={outro} onChange={setOutro} disabled={locked} />
            <OutputSelector value={output} onChange={setOutput} disabled={locked} />
            <fieldset disabled={locked} className="space-y-3">
                <legend className="text-sm font-medium mb-2">{t('batch.layout')}</legend>
                {(['perVideo', 'together'] as const).map(value => <label key={value} className="flex items-center gap-2 text-sm">
                    <input type="radio" name="batch-layout" checked={layout === value} onChange={() => setLayout(value)} />{t(`batch.${value}`)}
                </label>)}
            </fieldset>
            <div className="rounded-lg bg-slate-100 dark:bg-slate-800 p-3 text-xs">
                <p className="font-medium mb-2">{t('batch.preview')}</p>
                <pre className="overflow-x-auto">{layout === 'perVideo'
                    ? `${t('batch.batchFolder')}/\n├── 001_${t('batch.videoA')}/\n│   ├── 000001.mp4\n│   └── 000002.mp4\n├── 002_${t('batch.videoB')}/\n│   └── 000001.mp4\n└── 切分清单.csv`
                    : `${t('batch.batchFolder')}/\n├── 000001.mp4  (${t('batch.videoA')})\n├── 000002.mp4  (${t('batch.videoA')})\n├── 000003.mp4  (${t('batch.videoB')})\n└── 切分清单.csv`}</pre>
                <p className="mt-2 text-slate-500">{t('batch.filenameHint')}</p>
            </div>
        </section>
        {error && <p role="alert" className="text-sm text-red-500 whitespace-pre-wrap break-all">{error}</p>}
        {busy ? <button className={`${button} w-full text-red-500`} disabled={stopping || !result} onClick={stop}>{t(stopping ? 'batch.stopping' : 'batch.stop')}</button>
            : <button className="w-full rounded-xl py-4 bg-primary-600 text-white font-semibold disabled:opacity-40" disabled={!ready} onClick={() => start()}>{t('batch.start')}</button>}
        {busy && !result && <p role="status">{t('batch.preparing')}</p>}
        {result && <section className="glass rounded-xl p-4 space-y-4" aria-label={t('batch.results')}>
            <div className="flex justify-between items-center gap-2"><h2 className="font-medium">{t(`batch.status.${result.status}`)}</h2>
                <button className={button} onClick={() => openFolder(result.output_dir)}>{t('resultList.openFolder')}</button></div>
            <p className="text-sm" role="status">{t('batch.summary', { success: succeeded, failed: failed.length, total: result.items.length, seconds: (elapsed / 1000).toFixed(1) })}</p>
            <progress className="w-full" value={completed} max={result.items.length} aria-label={t('batch.progress')} />
            {busy && result.current_index !== null && <p className="text-sm">
                {t('batch.current', { index: result.current_index + 1, total: result.items.length })} · {filename(result.items[result.current_index].input_path)}
                {segment && segment.total_segments > 0 && ` · ${segment.current_segment} / ~${segment.total_segments}`}
                <span className="block text-xs text-slate-500 mt-1">{t('batch.progressHint')}</span>
            </p>}
            {result.error && <p role="alert" className="text-red-500 break-all">{result.error}</p>}
            <p className="text-xs text-slate-500 break-all">{result.output_dir}</p>
            <div className="space-y-2">{result.items.map((item, index) => <details key={item.input_path} className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                <summary className="cursor-pointer text-sm">{index + 1}. {filename(item.input_path)} · {t(`batch.status.${item.status}`)}{item.output_files.length > 0 && ` · ${t('batch.clips', { count: item.output_files.length })}`}</summary>
                {item.error && <p className="mt-2 text-xs text-red-500 whitespace-pre-wrap break-all">{item.error}</p>}
                {item.output_files.length > 0 && <div className="mt-3"><ResultList files={item.output_files} /></div>}
            </details>)}</div>
            {!busy && failed.length > 0 && <button className={button} disabled={!ready} onClick={() => start(failed.map(i => i.input_path))}>{t('batch.retry')}</button>}
        </section>}
    </div>;
}
