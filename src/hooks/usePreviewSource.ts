import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AppError } from '../types/error';
import { toAppError } from '../utils/appError';

export type PreviewSourceKind = 'file' | 'hls';

export interface PreviewSource {
    kind: PreviewSourceKind;
    path: string;
}

interface PreviewSourceOptions {
    minSizeBytes?: number;
    segmentSeconds?: number;
    startSeconds?: number;
    windowSeconds?: number;
    requestKey?: number;
}

const DEFAULT_MIN_SIZE_BYTES = 200 * 1024 * 1024;
const DEFAULT_SEGMENT_SECONDS = 6;

export function usePreviewSource(filePath: string, options: PreviewSourceOptions = {}) {
    const [source, setSource] = useState<PreviewSource | null>(null);
    const [isPreparing, setIsPreparing] = useState(false);
    const [prepareError, setPrepareError] = useState<AppError | null>(null);

    const minSizeBytes = options.minSizeBytes ?? DEFAULT_MIN_SIZE_BYTES;
    const segmentSeconds = options.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS;
    const startSeconds = options.startSeconds ?? 0;
    const windowSeconds = options.windowSeconds ?? 0;
    const requestKey = options.requestKey ?? 0;

    useEffect(() => {
        let cancelled = false;
        if (!filePath) {
            setSource(null);
            setIsPreparing(false);
            setPrepareError(null);
            return () => {
                cancelled = true;
            };
        }

        setSource(null);
        setPrepareError(null);
        setIsPreparing(true);

        invoke<PreviewSource>('prepare_hls_source_command', {
            inputPath: filePath,
            minSizeBytes,
            segmentSeconds,
            startSeconds,
            windowSeconds,
        })
            .then((result) => {
                if (!cancelled && result?.path) {
                    const kind = result.kind === 'hls' ? 'hls' : 'file';
                    setSource({ kind, path: result.path });
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setPrepareError(toAppError(err));
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setIsPreparing(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [filePath, minSizeBytes, segmentSeconds, startSeconds, windowSeconds, requestKey]);

    return {
        source,
        isPreparing,
        prepareError,
    };
}
