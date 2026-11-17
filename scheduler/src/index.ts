import { existsSync, readFileSync } from 'node:fs';
import { connect as mqttConnect, type MqttClient } from 'mqtt';
import type { SchedulerState } from '../../shared/types.ts';
import { Docker } from './docker.ts';

// One dongle, many decoders: run each slot's container in turn.
//
// A slot either starts/stops an existing container ("existing", used for Ultrafeeder)
// or creates a fresh auto-removed container from "image". Every created container
// gets the USB bus and host networking, so decoders can reach the collector's UDP
// ports and Mosquitto on 127.0.0.1.

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
}

const env = process.env;
const SLOTS_FILE = env.SLOTS_FILE ?? new URL('../slots.json', import.meta.url).pathname;
const DOCKER_SOCKET = env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const DRY_RUN = env.DRY_RUN === '1' || !existsSync(DOCKER_SOCKET);
const TIME_SCALE = Number(env.TIME_SCALE ?? 1); // e.g. 0.05 to rush through slots when testing
const TOPIC = 'airwaves/scheduler/state';
const CONTAINER_PREFIX = 'airwaves-slot-';

const slots: Slot[] = JSON.parse(readFileSync(SLOTS_FILE, 'utf8')).slots;
const docker = new Docker(DOCKER_SOCKET);
const loopMinutes = slots.reduce((a, s) => a + s.minutes, 0);

let mqtt: MqttClient | undefined;
if (env.MQTT_URL) {
  mqtt = mqttConnect(env.MQTT_URL, { username: env.MQTT_USER, password: env.MQTT_PASS, reconnectPeriod: 5000 });
  mqtt.on('connect', () => console.log('mqtt connected'));
  mqtt.on('error', (e) => console.warn('mqtt:', e.message));
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Substitutes ${VAR} in slot arguments: environment variables plus ${TS} (UTC timestamp). */
function expand(s: string): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  return s.replace(/\$\{(\w+)\}/g, (_, k: string) => (k === 'TS' ? ts : env[k] ?? ''));
}

function publish(index: number, since: number, endsAt: number) {
  const upNext = [1, 2, 3, 4].map((k) => slots[(index + k) % slots.length]).map((s) => ({ slotId: s.id, minutes: s.minutes }));
  const state: SchedulerState = { current: { slotId: slots[index].id, freqMhz: slots[index].freqMhz, since, endsAt }, upNext, slots: [...new Set(slots.map((x) => x.id))], loopMinutes, updatedAt: Date.now() };
  mqtt?.publish(TOPIC, JSON.stringify(state), { retain: true });
}

async function startSlot(s: Slot) {
  if (DRY_RUN) return log(`[dry run] start ${s.id}`);
  if (s.existing) return docker.start(s.existing);
  const name = CONTAINER_PREFIX + s.id;
  await docker.remove(name); // clear any leftover from a crash
  await docker.ensureImage(s.image!);
  await docker.create(name, {
    Image: s.image,
    Entrypoint: s.entrypoint,
    Cmd: s.cmd?.map(expand),
    Env: s.env?.map(expand),
    HostConfig: {
      AutoRemove: true,
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
  const name = CONTAINER_PREFIX + s.id;
  await docker.stop(name);
  await docker.waitGone(name); // the dongle is free only once the container is gone
}

/** Stops everything that might hold the dongle before the loop starts. */
async function clearDongle() {
  if (DRY_RUN) return;
  for (const s of slots) {
    if (s.existing && (await docker.isRunning(s.existing))) await docker.stop(s.existing, 10);
    if (!s.existing) await docker.remove(CONTAINER_PREFIX + s.id);
  }
}

let current: Slot | undefined;
let stopping = false;

async function loop() {
  await clearDongle();
  log(`starting rotation: ${slots.map((s) => `${s.id} ${s.minutes}m`).join(' → ')} (${loopMinutes} min loop)${DRY_RUN ? ' [dry run]' : ''}`);
  for (let i = 0; !stopping; i = (i + 1) % slots.length) {
    const s = slots[i];
    const since = Date.now();
    const durMs = s.minutes * 60_000 * TIME_SCALE;
    try {
      current = s;
      await startSlot(s);
      log(`▶ ${s.id} (${s.freqMhz} MHz) for ${s.minutes} min`);
      publish(i, since, since + durMs);
      const heartbeat = setInterval(() => publish(i, since, since + durMs), 30_000);
      await new Promise((r) => setTimeout(r, Math.max(0, since + durMs - Date.now())));
      clearInterval(heartbeat);
    } catch (e) {
      log(`✖ ${s.id} failed:`, e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, 5000));
    } finally {
      await stopSlot(s).catch((e) => log(`stop ${s.id} failed:`, e.message));
      current = undefined;
    }
  }
}

// On shutdown, stop the current slot and leave ADS-B running as the default.
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('shutting down');
  if (current) await stopSlot(current).catch(() => {});
  const adsb = slots.find((s) => s.existing);
  if (adsb && !DRY_RUN) await docker.start(adsb.existing!).catch(() => {});
  mqtt?.publish(TOPIC, '', { retain: true }, () => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await loop();
