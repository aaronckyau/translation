export type SessionPhase = 'connecting' | 'live' | 'reconnecting' | 'finishing' | 'stopped';
export interface Caption {
  id: number;
  english: string;
  chinese: string;
  startMs: number;
  endMs: number;
  translationState: 'pending' | 'done' | 'error';
}
export type ServerEvent =
  | { type: 'status'; phase: SessionPhase; message: string }
  | { type: 'interim'; english: string }
  | { type: 'preview'; english: string; chinese: string }
  | { type: 'caption'; caption: Caption }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'usage'; audioSeconds: number; estimatedUsd: number };
export interface AppConfig {
  configured: boolean;
  authenticated: boolean;
  requiresAccessCode: boolean;
  models: { transcription: string; translation: string };
  maxSessionMinutes: number;
}

export function parseServerEvent(value: unknown): ServerEvent | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.type === 'status' && ['connecting', 'live', 'reconnecting', 'finishing', 'stopped'].includes(String(v.phase)) && typeof v.message === 'string') return v as unknown as ServerEvent;
  if (v.type === 'interim' && typeof v.english === 'string') return v as unknown as ServerEvent;
  if (v.type === 'preview' && typeof v.english === 'string' && typeof v.chinese === 'string' && v.english.length <= 6000 && v.chinese.length <= 6000) return v as unknown as ServerEvent;
  if (v.type === 'error' && typeof v.message === 'string' && typeof v.fatal === 'boolean') return v as unknown as ServerEvent;
  if (v.type === 'usage' && typeof v.audioSeconds === 'number' && Number.isFinite(v.audioSeconds) && typeof v.estimatedUsd === 'number' && Number.isFinite(v.estimatedUsd)) return v as unknown as ServerEvent;
  if (v.type === 'caption' && v.caption && typeof v.caption === 'object') {
    const c = v.caption as Record<string, unknown>;
    if (Number.isSafeInteger(c.id) && typeof c.english === 'string' && typeof c.chinese === 'string' && typeof c.startMs === 'number' && Number.isFinite(c.startMs) && typeof c.endMs === 'number' && Number.isFinite(c.endMs) && c.endMs >= c.startMs && ['pending', 'done', 'error'].includes(String(c.translationState))) return v as unknown as ServerEvent;
  }
  return null;
}

export function mergeCaption(captions: Caption[], next: Caption): Caption[] {
  const index = captions.findIndex(c => c.id === next.id);
  if (index === -1) return [...captions, next].sort((a, b) => a.id - b.id);
  return captions.map(c => c.id === next.id ? next : c);
}
