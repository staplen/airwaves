// Raw decoder messages for the parsing audit: the last few messages per source and per kind
// (rtl_433 model, AIS message type, ACARS label, ...), kept in memory only and served on the local
// network at /api/raw. Nothing here is stored in the database or published.

export interface TapRule {
  perKind: number; // messages kept per kind
  maxKinds: number; // kinds kept per source (the least recently heard kind is dropped first)
  minIntervalMs?: number; // keep at most one message per kind per interval (e.g. one balloon frame a minute)
  maxChars?: number; // truncate long messages (HD Radio logs)
}

export interface TapEntry {
  ts: number;
  text: string;
}

interface Kind {
  entries: TapEntry[];
  total: number;
  lastTs: number;
  lastKept: number;
}

const DEFAULT_RULE: TapRule = { perKind: 5, maxKinds: 60, maxChars: 8000 };

export class RawTap {
  private sources = new Map<string, Map<string, Kind>>();
  private rules: Record<string, TapRule>;
  constructor(rules: Record<string, TapRule> = {}) {
    this.rules = rules;
  }

  add(source: string, kind: string, text: string, ts = Date.now()) {
    const rule = this.rules[source] ?? DEFAULT_RULE;
    let kinds = this.sources.get(source);
    if (!kinds) this.sources.set(source, (kinds = new Map()));
    let k = kinds.get(kind);
    if (!k) {
      if (kinds.size >= rule.maxKinds) {
        let oldest: string | undefined;
        for (const [name, v] of kinds) if (oldest === undefined || v.lastTs < kinds.get(oldest)!.lastTs) oldest = name;
        if (oldest !== undefined) kinds.delete(oldest);
      }
      kinds.set(kind, (k = { entries: [], total: 0, lastTs: 0, lastKept: -Infinity }));
    }
    k.total++;
    k.lastTs = ts;
    if (rule.minIntervalMs && ts - k.lastKept < rule.minIntervalMs) return;
    k.lastKept = ts;
    const max = rule.maxChars ?? DEFAULT_RULE.maxChars!;
    k.entries.push({ ts, text: text.length > max ? `${text.slice(0, max)}\n…[${text.length - max} more chars]` : text });
    if (k.entries.length > rule.perKind) k.entries.shift();
  }

  /** Per source: each kind with how often it was heard and when last. */
  summary() {
    const out: Record<string, { kind: string; total: number; kept: number; lastTs: number }[]> = {};
    for (const [source, kinds] of this.sources) {
      out[source] = [...kinds].map(([kind, v]) => ({ kind, total: v.total, kept: v.entries.length, lastTs: v.lastTs })).sort((a, b) => b.total - a.total);
    }
    return out;
  }

  /** All kept messages for one source, grouped by kind. */
  get(source: string): Record<string, TapEntry[]> {
    const kinds = this.sources.get(source);
    return kinds ? Object.fromEntries([...kinds].map(([kind, v]) => [kind, v.entries])) : {};
  }
}

/** Parses JSON without throwing. */
export function tryJson(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A short kind for a dumpvdl2 JSON message: the ACARS label, else the first message type under the AVLC frame. */
export function vdl2Kind(text: string): string {
  const avlc = (tryJson(text)?.vdl2 as Record<string, unknown> | undefined)?.avlc as Record<string, unknown> | undefined;
  if (!avlc) return 'other';
  const acars = avlc.acars as Record<string, unknown> | undefined;
  if (acars) return `acars ${String(acars.label ?? '?')}`;
  // Otherwise the first nested message (x25, xid, ...), else the frame type (link-layer S/U frames).
  const nested = Object.keys(avlc).find((k) => avlc[k] && typeof avlc[k] === 'object' && !['src', 'dst', 'cr'].includes(k));
  return nested ?? `frame ${String(avlc.frame_type ?? '?')}`;
}
