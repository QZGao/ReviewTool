import type { HighlightColor } from './types';

export type Stamp = readonly [number, string];
export interface Body { readonly text: string; readonly editedAt?: string; readonly editedBy?: string }
export interface Appearance { readonly color: HighlightColor; readonly editedAt?: string; readonly editedBy?: string }
export interface HighlightRecord {
  readonly kind: 'highlight'; readonly stamp: Stamp; readonly source: readonly [number, number];
  readonly author?: string; readonly createdAt?: string; readonly appearance: Appearance;
}
export interface CommentRecord {
  readonly kind: 'comment'; readonly stamp: Stamp; readonly highlight: string; readonly parent: string | null;
  readonly author: string; readonly createdAt: string; readonly body: Body;
}
interface Change { readonly target: string; readonly stamp: Stamp; readonly by: string; readonly at: string; readonly reason?: string }
export interface BodyRecord extends Change { readonly kind: 'body'; readonly text: string }
export interface AppearanceRecord extends Change { readonly kind: 'appearance'; readonly color: HighlightColor }
export interface RemovalRecord extends Change { readonly kind: 'resolve' | 'delete' }
export interface ResolutionRecord extends Change { readonly kind: 'resolution'; readonly resolved: boolean }
export type AnnotationRecord = HighlightRecord | CommentRecord | BodyRecord | AppearanceRecord | RemovalRecord | ResolutionRecord;
export type RecordSet = Readonly<Record<string, AnnotationRecord>>;
export interface RecordUpdate { readonly generation: string; readonly records: RecordSet }
export const recordKey = (record: BodyRecord | AppearanceRecord | RemovalRecord | ResolutionRecord): string => `${record.target}/${record.kind}/${record.stamp[0]}@${record.stamp[1]}`;
export const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const compareStamp = (a: Stamp, b: Stamp): number => a[0] - b[0] || compareText(a[1], b[1]);
