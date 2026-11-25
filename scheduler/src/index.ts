import { existsSync, readFileSync } from 'node:fs';
import { connect as mqttConnect, type MqttClient } from 'mqtt';
import { SDR_PROOF_MS, SdrWatch } from '../../shared/sdr.ts';
import type { SchedulerState } from '../../shared/types.ts';
import { Docker } from './docker.ts';

// One dongle, many decoders: run each slot's container in turn.
//
// A slot either starts/stops an existing container ("existing") or creates a fresh
// container from "image" with the USB bus and host networking, so decoders reach the
// collector's UDP ports and Mosquitto on 127.0.0.1.
//
// Extras:
//  - "windows": the slot only joins the loop during these local times (balloon launches,
//    the NOAA weekly test).
//  - "extendIfActive": keep the slot running a little longer while its source is busy.
//  - Interrupt: an MQTT message on airwaves/scheduler/interrupt ("what was that?" on the dashboard)
//    cuts the running slot short and puts ADS-B on for a few minutes, then the loop carries on.
//  - Health: a decoder that exits early is recorded as a failure (with its last log lines)
//    and published, so the dashboard can say "slot failed".
//  - Hung dongle: two failures that mean the dongle itself stopped (readsb's "SDR wedged", dump978's
//    "TIMEOUT") with no proof of life between them pause the loop. While it's hung, only a short ADS-B
//    check runs every few minutes (or right away on a "what was that?" tap), after an optional "reset"
//    container (e.g. a USB power cycle). The first check that streams resumes the loop where it stopped.
//    The state goes to the dashboard and to Home Assistant (an MQTT discovery "problem" sensor).

interface Window {
  days?: number[]; // 0 = Sunday … 6 = Saturday; omit for every day
  start: string; // "HH:MM" local
  end: string;
}

interface Slot {
  id: string;
  name: string;
  freqMhz: number;
  minutes: number;
  existing?: string;
  image?: string;
  entrypoint?: string[];
  cmd?: string[];
  binds?: string[];
  env?: string[];
  windows?: Window[];
  extendIfActive?: { withinSec: number; maxExtraMinutes: number };
  everyLoops?: number; // only join every Nth pass of the loop (0, N, 2N, …)
  everyMinutes?: number; // only join a pass if it last ran at least this long ago (e.g. 60 = hourly)
  runsOnce?: boolean; // the decoder does one job and exits (e.g. a spectrum sweep): exit code 0 ends the slot early, normally
  beta?: boolean; // exploratory: listening/recording, but not (yet) decoded into the feed or map
}

interface Config {
  slots: Slot[];
  standby?: string; // container that owns the dongle when the scheduler isn't running (stopped at start, started on exit)
  // Run while the dongle is hung, before a check (at most every `everyMinutes`, default 10): e.g. a USB power
  // cycle with uhubctl. Runs privileged with the host's USB bus; it should exit when done.
  reset?: { image: string; entrypoint?: string[]; cmd?: string[]; everyMinutes?: number };
}

const env = process.env;
const SLOTS_FILE = env.SLOTS_FILE ?? new URL('../slots.json', import.meta.url).pathname;
const DOCKER_SOCKET = env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const DRY_RUN = env.DRY_RUN === '1' || !existsSync(DOCKER_SOCKET);
const TIME_SCALE = Number(env.TIME_SCALE ?? 1); // e.g. 0.05 to rush through slots when testing
const COLLECTOR_URL = env.COLLECTOR_URL ?? 'http://127.0.0.1:8090';
const TIMEZONE = env.TIMEZONE ?? 'America/New_York';
const TOPIC = 'airwaves/scheduler/state';
const RESUME_TOPIC = 'airwaves/scheduler/resume';
const INTERRUPT_TOPIC = 'airwaves/scheduler/interrupt';
const INTERRUPT_MAX_MIN = 10;
const SDR_TOPIC = 'airwaves/sdr'; // retained: {state: "ok" | "hung", since, lastOk, resets}
const HA_DISCOVERY_TOPIC = 'homeassistant/binary_sensor/airwaves_sdr/config';
const HUNG_CHECK_EVERY_MS = 3 * 60_000; // while hung: how often to see whether the dongle is back

interface Resume {
  slotId: string;
  index: number;
  since: number;
  endsAt: number;
  at: number;
}

/** Reads the retained resume point from MQTT (waits a few seconds for the broker). */
async function readResume(): Promise<Resume | undefined> {
  if (!mqtt) return undefined;
  const client = mqtt;
  return new Promise((resolve) => {
    const done = (r?: Resume) => {
      clearTimeout(timer);
      client.removeListener('message', onMsg);
      client.unsubscribe(RESUME_TOPIC);
      resolve(r);
    };
    const onMsg = (topic: string, payload: Buffer) => {
      if (topic !== RESUME_TOPIC) return;
      try {
        done(payload.length ? (JSON.parse(payload.toString()) as Resume) : undefined);
      } catch {
        done();
      }
    };
    const timer = setTimeout(() => done(), 5000);
    client.on('message', onMsg);
    client.subscribe(RESUME_TOPIC);
  });
}

/** Where to start the first pass: the interrupted slot again if it hadn't got halfway, otherwise the next one. */
export function resumeIndex(loop: { id: string }[], r: Resume | undefined, now: number): number {
  if (!r || now - r.at > 3 * 3600_000 || !loop.length) return 0;
  let idx = loop[r.index]?.id === r.slotId ? r.index : loop.findIndex((s) => s.id === r.slotId);
  if (idx < 0) return 0;
  const fraction = r.endsAt > r.since ? (r.at - r.since) / (r.endsAt - r.since) : 1;
  if (fraction >= 0.5) idx += 1;
  return idx % loop.length;
}
const CONTAINER_PREFIX = 'airwaves-slot-';
const HEALTH_EVERY_MS = 15_000;

const config: Config = JSON.parse(readFileSync(SLOTS_FILE, 'utf8'));
const allSlots = config.slots;
const docker = new Docker(DOCKER_SOCKET);
const failures: Record<string, { at: number; reason: string }> = {};
const sdr = new SdrWatch();
const slotLogs: Record<string, { at: number; lines: string[] }> = {}; // last output of each slot's decoder, for debugging quiet slots

let mqtt: MqttClient | undefined;
if (env.MQTT_URL) {
  mqtt = mqttConnect(env.MQTT_URL, { username: env.MQTT_USER, password: env.MQTT_PASS, reconnectPeriod: 5000 });
  mqtt.on('connect', () => {
    console.log('mqtt connected');
    publishDiscovery();
    publishSdr();
  });
  mqtt.on('error', (e) => console.warn('mqtt:', e.message));
  mqtt.subscribe(INTERRUPT_TOPIC);
  mqtt.on('message', (topic, payload) => {
    if (topic === INTERRUPT_TOPIC) onInterrupt(payload.toString());
  });
}

// ---- interrupts ------------------------------------------------------------------------------------
/** A pending request to put one slot on the air now, until `until`. `at` is when it was asked (for timing logs). */
let interrupt: { slotId: string; until: number; at: number } | undefined;
let tapAt = 0; // the latest request's time, so the log can say how long each step took after it
const sinceTap = () => `+${((Date.now() - tapAt) / 1000).toFixed(1)}s after the tap`;
let wake: (() => void) | undefined; // cuts the current slot's wait short

/** Parses an interrupt request; ignores stale or unknown ones (e.g. replayed after a broker restart). */
export function parseInterrupt(text: string, now: number, slotIds: string[]): { slotId: string; until: number; at: number } | undefined {
  try {
    const m = JSON.parse(text) as { slotId?: unknown; minutes?: unknown; at?: unknown };
    const slotId = typeof m.slotId === 'string' ? m.slotId : 'adsb';
    const at = typeof m.at === 'number' ? m.at : now;
    if (!slotIds.includes(slotId) || now - at > 30_000) return undefined;
    const minutes = Math.min(INTERRUPT_MAX_MIN, Math.max(0.5, typeof m.minutes === 'number' ? m.minutes : 3));
    return { slotId, until: now + minutes * 60_000 * TIME_SCALE, at };
  } catch {
    return undefined;
  }
}

function onInterrupt(text: string) {
  const req = parseInterrupt(text, Date.now(), allSlots.map((s) => s.id));
  if (!req) return;
  // A second tap while one is pending or running only stretches it.
  interrupt = { slotId: req.slotId, until: Math.max(req.until, interrupt?.slotId === req.slotId ? interrupt.until : 0), at: req.at };
  tapAt = req.at;
  log(`⚡ interrupt: ${req.slotId} until ${new Date(interrupt.until).toISOString().slice(11, 19)} (${sinceTap()})`);
  wake?.();
}

const pendingInterrupt = () => interrupt;

/** Sleeps, but wakes early when an interrupt arrives. */
function nap(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      if (wake === done) wake = undefined;
      resolve();
    };
    const t = setTimeout(done, ms);
    wake = done;
  });
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- time windows ------------------------------------------------------------------------------
const CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function localNow(): { day: number; minutes: number } {
  const parts = Object.fromEntries(CLOCK.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { day: DAYS.indexOf(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
function inWindow(s: Slot): boolean {
  if (!s.windows) return true;
  const { day, minutes } = localNow();
  return s.windows.some((w) => (!w.days || w.days.includes(day)) && minutes >= toMin(w.start) && minutes < toMin(w.end));
}
/** The loop as it stands right now: always-on slots plus any whose window is open. */
const lastRunAt = new Map<Slot, number>();
const dueByTime = (s: Slot) => !s.everyMinutes || Date.now() - (lastRunAt.get(s) ?? 0) >= (s.everyMinutes - 1) * 60_000 * TIME_SCALE;
const activeSlots = (pass: number) => allSlots.filter((s) => inWindow(s) && (!s.everyLoops || pass % s.everyLoops === 0) && dueByTime(s));

// ---- arguments -----------------------------------------------------------------------------------
/** Substitutes ${VAR} from the environment plus ${TS} (UTC timestamp). */
function expand(s: string): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  return s.replace(/\$\{(\w+)\}/g, (_, k: string) => (k === 'TS' ? ts : env[k] ?? ''));
}
/** Expands a command line, dropping "--flag <value>" pairs whose value came out empty. */
function expandArgs(args?: string[]): string[] | undefined {
  if (!args) return undefined;
  const out: string[] = [];
  for (const a of args) {
    const v = expand(a);
    if (v === '' && out.length && out[out.length - 1].startsWith('-')) out.pop();
    else out.push(v);
  }
  return out;
}

// ---- publishing ------------------------------------------------------------------------------------
function publish(loop: Slot[], index: number, since: number, endsAt: number) {
  const s = loop[index];
  const upNext = [1, 2, 3, 4].map((k) => loop[(index + k) % loop.length]).map((x) => ({ slotId: x.id, minutes: x.minutes }));
  const state: SchedulerState = {
    current: { slotId: s.id, freqMhz: s.freqMhz, since, endsAt },
    upNext,
    slots: [...new Set(allSlots.map((x) => x.id))],
    beta: [...new Set(allSlots.filter((x) => x.beta).map((x) => x.id))],
    names: Object.fromEntries(allSlots.map((x) => [x.id, x.name.replace(/\s*\((?:night|deep|weekly|locomotive|beta)\)$/i, '')]).reverse()),
    failures,
    slotLogs,
    loop: loop.map((x) => ({ slotId: x.id, minutes: x.minutes, freqMhz: x.freqMhz })),
    index,
    loopMinutes: loop.reduce((a, x) => a + x.minutes, 0),
    sdr: sdr.health,
    updatedAt: Date.now(),
  };
  mqtt?.publish(TOPIC, JSON.stringify(state), { retain: true });
  // Resume point for the next start: which slot was running and how far it got.
  mqtt?.publish(RESUME_TOPIC, JSON.stringify({ slotId: s.id, index, since, endsAt, at: Date.now() }), { retain: true });
}

function fail(s: Slot, reason: string) {
  failures[s.id] = { at: Date.now(), reason: reason.slice(0, 200) };
  log(`✖ ${s.id}: ${reason}`);
  if (sdr.failed(reason, Date.now())) {
    log('⚠ the dongle looks hung: pausing the loop, checking ADS-B every few minutes');
    publishSdr();
  }
}

/** The dongle's health on its own retained topic, for Home Assistant. */
function publishSdr() {
  const h = sdr.health;
  mqtt?.publish(SDR_TOPIC, JSON.stringify({ state: h.state, since: iso(h.since), last_ok: iso(h.lastOk), resets: h.resets }), { retain: true });
}
const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : null);

/** Home Assistant MQTT discovery: a "problem" binary sensor that's on while the dongle is hung. */
function publishDiscovery() {
  const config = {
    name: 'Airwaves SDR',
    unique_id: 'airwaves_sdr',
    device_class: 'problem',
    state_topic: SDR_TOPIC,
    value_template: '{{ value_json.state }}',
    payload_on: 'hung',
    payload_off: 'ok',
    json_attributes_topic: SDR_TOPIC,
    device: { identifiers: ['airwaves'], name: 'Airwaves', manufacturer: 'Airwaves', model: 'RTL-SDR scheduler' },
  };
  mqtt?.publish(HA_DISCOVERY_TOPIC, JSON.stringify(config), { retain: true });
}

/** State while the loop is paused on a hung dongle (nothing on air between checks). */
function publishPaused() {
  const state: SchedulerState = {
    upNext: [],
    slots: [...new Set(allSlots.map((x) => x.id))],
    beta: [...new Set(allSlots.filter((x) => x.beta).map((x) => x.id))],
    names: Object.fromEntries(allSlots.map((x) => [x.id, x.name]).reverse()),
    failures,
    slotLogs,
    loopMinutes: 0,
    sdr: sdr.health,
    updatedAt: Date.now(),
  };
  mqtt?.publish(TOPIC, JSON.stringify(state), { retain: true });
}

// ---- slot lifecycle -----------------------------------------------------------------------------------
const containerName = (s: Slot) => s.existing ?? CONTAINER_PREFIX + s.id;

async function startSlot(s: Slot) {
  if (DRY_RUN) return log(`[dry run] start ${s.id}`);
  if (s.existing) return docker.start(s.existing);
  const name = containerName(s);
  await docker.remove(name); // clear any leftover from a crash
  await docker.ensureImage(s.image!);
  await docker.create(name, {
    Image: s.image,
    Entrypoint: s.entrypoint,
    Cmd: expandArgs(s.cmd),
    Env: s.env?.map(expand),
    HostConfig: {
      // Not auto-removed, so an early exit's logs can still be read; removed after stopping.
      NetworkMode: 'host',
      Binds: s.binds,
      Devices: [{ PathOnHost: '/dev/bus/usb', PathInContainer: '/dev/bus/usb', CgroupPermissions: 'rwm' }],
    },
  });
  await docker.start(name);
}

/** Stops a slot's decoder. `fast` (cut short for an interrupt) kills it at once instead of asking it to exit. */
async function stopSlot(s: Slot, fast = false) {
  if (DRY_RUN) return log(`[dry run] stop ${s.id}`);
  if (s.existing) return docker.stop(s.existing, fast ? 0 : 10);
  const name = containerName(s);
  // Keep the decoder's last words before the container goes (slots that hear nothing exit cleanly and leave no failure).
  const out = await docker.logs(name, 15).catch(() => '');
  if (out) slotLogs[s.id] = { at: Date.now(), lines: out.split('\n').map((l) => l.replace(/[\x00-\x08\x0e-\x1f]/g, '').slice(0, 200)).filter(Boolean).slice(-15) };
  // Every decoder exits within a second or two of SIGTERM; don't idle the dongle longer. When cut short for an
  // interrupt, the forced remove alone kills it straight away (a half-recorded clip may be lost; that's the trade).
  if (!fast) await docker.stop(name, 3);
  await docker.remove(name); // the dongle is free only once the container is gone
  await docker.waitGone(name);
}

/** Checks the decoder is still running; records a failure with its last output if not. */
async function healthy(s: Slot): Promise<boolean> {
  if (DRY_RUN) return true;
  const st = await docker.state(containerName(s)).catch(() => undefined);
  if (st?.running) return true;
  if (s.runsOnce && st && st.exitCode === 0) return false; // finished its job: end the slot, not a failure
  const tail = (await docker.logs(containerName(s), 6).catch(() => '')).split('\n').filter(Boolean).slice(-2).join(' / ');
  fail(s, st ? `decoder exited (code ${st.exitCode})${tail ? `: ${tail}` : ''}` : 'decoder container disappeared');
  return false;
}

/** Asks the collector whether this slot's source was heard in the last `withinSec`. */
async function busy(s: Slot, withinSec: number): Promise<boolean> {
  try {
    const r = await fetch(`${COLLECTOR_URL}/api/snapshot`, { signal: AbortSignal.timeout(3000) });
    const d = (await r.json()) as { snapshot: { sources: { id: string; lastHeard?: number }[] } };
    const heard = d.snapshot.sources.find((x) => x.id === s.id)?.lastHeard ?? 0;
    return Date.now() - heard < withinSec * 1000;
  } catch {
    return false;
  }
}

/** Stops everything that might hold the dongle before the loop starts. */
async function clearDongle() {
  if (DRY_RUN) return;
  if (config.standby && (await docker.isRunning(config.standby))) await docker.stop(config.standby, 10);
  for (const s of allSlots) {
    if (s.existing && (await docker.isRunning(s.existing))) await docker.stop(s.existing, 10);
    if (!s.existing) await docker.remove(CONTAINER_PREFIX + s.id);
  }
}

let current: Slot | undefined;
let stopping = false;

async function runSlot(loop: Slot[], i: number) {
  const s = loop[i];
  const since = Date.now();
  let endsAt = since + s.minutes * 60_000 * TIME_SCALE;
  let extra = 0;
  let cut = false; // ended early for an interrupt
  current = s;
  lastRunAt.set(s, since);
  try {
    await startSlot(s);
    log(`▶ ${s.id} (${s.freqMhz} MHz) for ${Math.round(s.minutes * 10) / 10} min${interrupt?.slotId === s.id ? ` (${sinceTap()})` : ''}`);
    publish(loop, i, since, endsAt);
    let lastBeat = Date.now();
    while (!stopping) {
      if (interrupt) {
        if (interrupt.slotId !== s.id) {
          cut = true; // another slot is wanted now: end this one early
          break;
        }
        // This slot is the one wanted (already on, or started for the interrupt): stay on until it's done.
        if (interrupt.until > endsAt) {
          endsAt = interrupt.until;
          publish(loop, i, since, endsAt);
        }
        interrupt = undefined;
      }
      const left = endsAt - Date.now();
      if (left <= 0) {
        // Busy at the end of the slot? Stay another minute (up to the limit).
        const ext = s.extendIfActive;
        if (ext && extra < ext.maxExtraMinutes && (await busy(s, ext.withinSec))) {
          extra++;
          endsAt += 60_000 * TIME_SCALE;
          log(`↻ ${s.id} busy, extending (+${extra} min)`);
          publish(loop, i, since, endsAt);
          continue;
        }
        break;
      }
      await nap(Math.min(left, HEALTH_EVERY_MS));
      const req = pendingInterrupt(); // (a function call: TypeScript can't see the MQTT handler set it during the nap)
      if (req && req.slotId !== s.id) {
        cut = true;
        break;
      }
      if (!(await healthy(s))) break; // decoder died: move on rather than sit on a dead slot
      // readsb still up well past its "wedged" timeout: the dongle is streaming.
      if (s.id === 'adsb' && Date.now() - since >= SDR_PROOF_MS * TIME_SCALE && (sdr.hung || sdr.health.strikes > 0 || !sdr.health.lastOk || Date.now() - sdr.health.lastOk > 60_000)) {
        if (sdr.ok(Date.now())) log('✔ the dongle is streaming again: resuming the loop');
        publishSdr();
      }
      if (Date.now() - lastBeat > 30_000) {
        publish(loop, i, since, endsAt);
        lastBeat = Date.now();
      }
    }
  } catch (e) {
    fail(s, e instanceof Error ? e.message : String(e));
    await sleep(3000);
  } finally {
    await stopSlot(s, cut).catch((e) => log(`stop ${s.id} failed:`, e.message));
    if (cut) log(`■ ${s.id} cut short (${sinceTap()})`);
    current = undefined;
  }
}

/** Runs the requested slot right after slot `i` (as an extra entry, so the dashboard's "up next" stays right). */
async function runInterrupt(loop: Slot[], i: number) {
  const want = interrupt!;
  const base = allSlots.find((s) => s.id === want.slotId && !s.windows) ?? allSlots.find((s) => s.id === want.slotId);
  if (!base || want.until <= Date.now()) return void (interrupt = undefined);
  const minutes = Math.max(0.5, (want.until - Date.now()) / 60_000 / TIME_SCALE);
  const withExtra = [...loop.slice(0, i + 1), { ...base, name: `${base.name} (on demand)`, minutes }, ...loop.slice(i + 1)];
  await runSlot(withExtra, i + 1); // runSlot clears `interrupt` once it's on
  // Still the same request (the decoder failed to start)? Drop it, or every slot after would quit at once to retry.
  if (pendingInterrupt() === want) interrupt = undefined;
}

/** The dongle is hung: no point rotating. Reset it if we can, check it with ADS-B, repeat until it streams. */
async function whileHung() {
  const adsb = allSlots.find((s) => s.id === 'adsb' && !s.windows);
  if (!adsb) return;
  while (sdr.hung && !stopping) {
    const r = config.reset;
    if (r && sdr.resetDue(Date.now(), (r.everyMinutes ?? 10) * 60_000)) {
      sdr.resetTried(Date.now());
      await resetDongle(r).catch((e) => log('reset failed:', e instanceof Error ? e.message : String(e)));
      publishSdr();
    }
    // Only an aircraft request matters now; anything else would cut the check short.
    if (interrupt && interrupt.slotId !== adsb.id) interrupt = undefined;
    const check: Slot = { ...adsb, name: `${adsb.name} (checking the dongle)`, minutes: Math.max(0.75, adsb.minutes) };
    await runSlot([check], 0);
    if (!sdr.hung || stopping) break;
    publishPaused();
    await nap(HUNG_CHECK_EVERY_MS * TIME_SCALE); // a tap wakes it for an immediate check
  }
}

/** Runs the configured reset container (privileged, host USB) and waits for it to exit. */
async function resetDongle(r: NonNullable<Config['reset']>) {
  if (DRY_RUN) return log('[dry run] reset dongle');
  const name = `${CONTAINER_PREFIX}reset`;
  log('↺ resetting the dongle');
  await docker.remove(name);
  await docker.ensureImage(r.image);
  await docker.create(name, {
    Image: r.image,
    Entrypoint: r.entrypoint,
    Cmd: expandArgs(r.cmd),
    HostConfig: { NetworkMode: 'host', Privileged: true, Binds: ['/dev/bus/usb:/dev/bus/usb'] },
  });
  await docker.start(name);
  const until = Date.now() + 60_000;
  while (Date.now() < until && (await docker.isRunning(name))) await sleep(1000);
  const out = await docker.logs(name, 6).catch(() => '');
  if (out) log(`↺ reset said: ${out.split('\n').slice(-3).join(' / ')}`);
  await docker.remove(name);
  await sleep(5000); // let the dongle come back on the bus
}

async function main() {
  await clearDongle();
  log(`slots: ${allSlots.map((s) => `${s.id} ${s.minutes}m${s.windows ? ' (windowed)' : ''}`).join(' → ')}${DRY_RUN ? ' [dry run]' : ''}`);
  // Pick up where the previous run left off (e.g. after an update), so later slots aren't starved.
  let start = resumeIndex(activeSlots(0), await readResume(), Date.now());
  if (start > 0) log(`resuming at slot ${start + 1} (${activeSlots(0)[start].id})`);
  // Rebuild the loop at the start of each pass so windowed slots join and leave on time.
  for (let pass = 0; !stopping; pass++) {
    const loop = activeSlots(pass);
    for (let i = Math.min(start, loop.length - 1); i < loop.length && !stopping; i++) {
      if (sdr.hung) await whileHung();
      await runSlot(loop, i);
      if (interrupt && !stopping) await runInterrupt(loop, i);
    }
    start = 0;
  }
}

// On shutdown, stop the current slot and hand the dongle back to the standby container.
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('shutting down');
  if (current) await stopSlot(current).catch(() => {});
  const standby = config.standby ?? allSlots.find((s) => s.existing)?.existing;
  if (standby && !DRY_RUN) await docker.start(standby).catch(() => {});
  mqtt?.publish(TOPIC, '', { retain: true }, () => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await main();
