export type AppendKind = 'image' | 'video';

export interface AppendSource {
    kind: AppendKind;
    path: string;
    durationSeconds?: number;
}
