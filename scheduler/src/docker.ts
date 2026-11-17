import { request } from 'node:http';

/** Tiny Docker Engine API client over the unix socket (no dependencies). */
export class Docker {
  private socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  call(method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<{ status: number; data: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        { socketPath: this.socketPath, method, path, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}, timeout: timeoutMs },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
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
