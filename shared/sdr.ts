// Is the dongle working? Shared by the scheduler (which acts on it) and the collector (which reports it).
//
// A hung RTL-SDR still shows up on USB, opens and tunes, but sends no samples: readsb quits after about
// 17 s with "SDR wedged", dump978 with "TIMEOUT". A missing one fails to open at all. Decoders that
// only listen (airband, ACARS) just hear nothing and never fail, so they can't tell us anything.

const SDR_DOWN = /wedged|TIMEOUT|No supported devices|usb_open|usb_claim|PLL not locked|Failed to open rtlsdr/i;

/** True when a decoder's failure means the dongle itself isn't working (not a config or image problem). */
export const isSdrDown = (reason: string): boolean => SDR_DOWN.test(reason);

/** How long readsb must stay up to prove samples are flowing (it gives up on a silent dongle after ~17 s). */
export const SDR_PROOF_MS = 25_000;

export interface SdrHealth {
  state: 'ok' | 'hung';
  since?: number; // first sign of trouble in the current run of failures
  lastOk?: number; // last time readsb ran long enough to prove the dongle was streaming
  strikes: number; // dongle failures since lastOk
  resets: number; // automatic resets tried in the current hang
  lastReset?: number;
}

/**
 * Two dongle failures with no proof of life in between means it's hung (one alone can be a slot
 * starting before the last one let go). Any proof of life clears it.
 */
export class SdrWatch {
  health: SdrHealth = { state: 'ok', strikes: 0, resets: 0 };
  private strikesToHang: number;

  constructor(strikesToHang = 2) {
    this.strikesToHang = strikesToHang;
  }

  get hung(): boolean {
    return this.health.state === 'hung';
  }

  /** A decoder failed. Returns true when this failure tips it into "hung". */
  failed(reason: string, now: number): boolean {
    if (!isSdrDown(reason)) return false;
    const h = this.health;
    h.strikes++;
    h.since ??= now;
    if (h.state === 'ok' && h.strikes >= this.strikesToHang) {
      h.state = 'hung';
      return true;
    }
    return false;
  }

  /** The dongle streamed. Returns true when this ends a hang. */
  ok(now: number): boolean {
    const was = this.hung;
    this.health = { state: 'ok', strikes: 0, resets: 0, lastOk: now };
    return was;
  }

  /** An automatic reset (USB power cycle) is due: at most one per `everyMs`. */
  resetDue(now: number, everyMs: number): boolean {
    return this.hung && now - (this.health.lastReset ?? 0) >= everyMs;
  }

  resetTried(now: number): void {
    this.health.resets++;
    this.health.lastReset = now;
  }
}
