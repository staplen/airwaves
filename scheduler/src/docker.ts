import { request } from 'node:http';

/** Tiny Docker Engine API client over the unix socket (no dependencies). */
export class Docker {
  private socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async call(method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<{ status: number; data: string }> {
    const r = await this.callRaw(method, path, body, timeoutMs);
    return { status: r.status, data: r.data.toString('utf8') };
  }

  callRaw(method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<{ status: number; data: Buffer }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        { socketPath: this.socketPath, method, path, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}, timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) }));
        },
      );
      req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async ensureImage(image: string): Promise<void> {
    const r = await this.call('GET', `/images/${encodeURIComponent(image)}/json`);
    if (r.status === 200) return;
    const [repo, tag] = splitImage(image);
    console.log(`pulling ${image}…`);
    const p = await this.call('POST', `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`, undefined, 15 * 60_000);
    if (p.status !== 200) throw new Error(`pull ${image} failed: ${p.status} ${p.data.slice(0, 200)}`);
  }

  /** Container state, or undefined if it doesn't exist. */
  async state(name: string): Promise<{ running: boolean; exitCode: number; error: string } | undefined> {
    const r = await this.call('GET', `/containers/${encodeURIComponent(name)}/json`);
    if (r.status !== 200) return undefined;
    const st = JSON.parse(r.data).State ?? {};
    return { running: Boolean(st.Running), exitCode: Number(st.ExitCode ?? 0), error: String(st.Error ?? '') };
  }

  /** Last lines of a container's output (stdout+stderr), with Docker's stream framing removed. */
  async logs(name: string, tail = 15): Promise<string> {
    const r = await this.callRaw('GET', `/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&tail=${tail}`);
    if (r.status !== 200) return '';
    return unframeLogs(r.data);
  }

  async isRunning(name: string): Promise<boolean> {
    const r = await this.call('GET', `/containers/${encodeURIComponent(name)}/json`);
    if (r.status !== 200) return false;
    return Boolean(JSON.parse(r.data).State?.Running);
  }

  async start(name: string): Promise<void> {
    const r = await this.call('POST', `/containers/${encodeURIComponent(name)}/start`);
    if (r.status !== 204 && r.status !== 304) throw new Error(`start ${name}: ${r.status} ${r.data.slice(0, 200)}`);
  }

  async stop(name: string, graceS = 8): Promise<void> {
    const r = await this.call('POST', `/containers/${encodeURIComponent(name)}/stop?t=${graceS}`, undefined, (graceS + 30) * 1000);
    if (r.status !== 204 && r.status !== 304 && r.status !== 404) throw new Error(`stop ${name}: ${r.status} ${r.data.slice(0, 200)}`);
  }

  async remove(name: string): Promise<void> {
    await this.call('DELETE', `/containers/${encodeURIComponent(name)}?force=true`);
  }

  /** Waits until a container no longer exists (auto-removed after stopping). */
  async waitGone(name: string, maxMs = 20_000): Promise<void> {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      const r = await this.call('GET', `/containers/${encodeURIComponent(name)}/json`);
      if (r.status === 404) return;
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  async create(name: string, spec: unknown): Promise<void> {
    const r = await this.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec);
    if (r.status !== 201) throw new Error(`create ${name}: ${r.status} ${r.data.slice(0, 300)}`);
  }
}

function splitImage(image: string): [string, string] {
  const at = image.lastIndexOf(':');
  const slash = image.lastIndexOf('/');
  return at > slash ? [image.slice(0, at), image.slice(at + 1)] : [image, 'latest'];
}

/**
 * Non-TTY container logs are framed: an 8-byte header (stream, 0, 0, 0, payload size big-endian) before each
 * payload. Strips the headers properly (the size's last byte is often a printable character, so removing control
 * characters alone left one stray letter per line), then drops any remaining control characters.
 */
export function unframeLogs(buf: Buffer): string {
  const framed = buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  let text: string;
  if (framed) {
    const parts: Buffer[] = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      parts.push(buf.subarray(i + 8, Math.min(buf.length, i + 8 + size)));
      i += 8 + size;
    }
    text = Buffer.concat(parts).toString('utf8');
  } else text = buf.toString('utf8');
  return text.replace(/[\u0000-\u0008\u000e-\u001f]/g, '').trim();
}
