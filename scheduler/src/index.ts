import { existsSync, readFileSync } from 'node:fs';
import { connect as mqttConnect, type MqttClient } from 'mqtt';
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
//  - Health: a decoder that exits early is recorded as a failure (with its last log lines)
//    and published, so the dashboard can say "slot failed".

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
const slotLogs: Record<string, { at: number; lines: string[] }> = {}; // last output of each slot's decoder, for debugging quiet slots

let mqtt: MqttClient | undefined;
if (env.MQTT_URL) {
  mqtt = mqttConnect(env.MQTT_URL, { username: env.MQTT_USER, password: env.MQTT_PASS, reconnectPeriod: 5000 });
  mqtt.on('connect', () => console.log('mqtt connected'));
  mqtt.on('error', (e) => console.warn('mqtt:', e.message));
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
    updatedAt: Date.now(),
  };
  mqtt?.publish(TOPIC, JSON.stringify(state), { retain: true });
  // Resume point for the next start: which slot was running and how far it got.
  mqtt?.publish(RESUME_TOPIC, JSON.stringify({ slotId: s.id, index, since, endsAt, at: Date.now() }), { retain: true });
}

function fail(s: Slot, reason: string) {
  failures[s.id] = { at: Date.now(), reason: reason.slice(0, 200) };
  log(`✖ ${s.id}: ${reason}`);
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

async function stopSlot(s: Slot) {
  if (DRY_RUN) return log(`[dry run] stop ${s.id}`);
  if (s.existing) return docker.stop(s.existing, 10);
  const name = containerName(s);
  // Keep the decoder's last words before the container goes (slots that hear nothing exit cleanly and leave no failure).
  const out = await docker.logs(name, 15).catch(() => '');
  if (out) slotLogs[s.id] = { at: Date.now(), lines: out.split('\n').map((l) => l.replace(/[\x00-\x08\x0e-\x1f]/g, '').slice(0, 200)).filter(Boolean).slice(-15) };
  await docker.stop(name, 3); // every decoder exits within a second or two of SIGTERM; don't idle the dongle longer
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
  current = s;
  lastRunAt.set(s, since);
  try {
    await startSlot(s);
    log(`▶ ${s.id} (${s.freqMhz} MHz) for ${s.minutes} min`);
    publish(loop, i, since, endsAt);
    let lastBeat = Date.now();
    while (!stopping) {
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
      await sleep(Math.min(left, HEALTH_EVERY_MS));
      if (!(await healthy(s))) break; // decoder died: move on rather than sit on a dead slot
      if (Date.now() - lastBeat > 30_000) {
        publish(loop, i, since, endsAt);
        lastBeat = Date.now();
      }
    }
  } catch (e) {
    fail(s, e instanceof Error ? e.message : String(e));
    await sleep(3000);
  } finally {
    await stopSlot(s).catch((e) => log(`stop ${s.id} failed:`, e.message));
    current = undefined;
  }
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
    for (let i = Math.min(start, loop.length - 1); i < loop.length && !stopping; i++) await runSlot(loop, i);
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
