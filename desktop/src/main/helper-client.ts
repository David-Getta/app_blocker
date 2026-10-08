// Socket client used by the GUI process to talk to the privileged helper.

import * as net from 'net';
import { socketPath } from '../helper/paths';
import type { HelperRequest, HelperResponse } from '../shared/protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export interface HelperClientOptions {
  /**
   * Windows: az app kulcsa a segédhez (shared/client-key.ts). Ha van, minden
   * kapcsolat első sora a `hello` vele — a kulcsos segéd enélkül szóba sem áll.
   */
  key?: () => string | null;
}

export class HelperClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly opts: HelperClientOptions = {}) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  /** Concurrent callers share the same in-flight connection attempt. */
  private connect(): Promise<void> {
    // Előbb a folyamatban lévő kapcsolódás: a kézfogás alatt a socket már él,
    // de a kérések a `hello` válaszát várják meg.
    if (this.connectPromise) return this.connectPromise;
    if (this.socket) return Promise.resolve();
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath());
      sock.setEncoding('utf8');
      const fail = (err: Error) => {
        this.connectPromise = null;
        this.teardown();
        reject(err);
      };
      sock.once('error', fail);
      sock.once('connect', () => {
        sock.removeListener('error', fail);
        this.socket = sock;
        sock.on('data', (chunk: string) => this.onData(chunk));
        sock.on('error', () => this.teardown());
        sock.on('close', () => this.teardown());
        const key = this.opts.key?.() ?? null;
        if (key === null) {
          this.connectPromise = null;
          resolve();
          return;
        }
        // A kulcs az ELSŐ sor: a kulcsos Windows-segéd minden mást elutasít.
        // A régi segéd nem ismeri a `hello`-t (UNKNOWN_OP) — a kapcsolat
        // attól még él, és a többi parancs megy.
        this.send('hello', { key }).then(() => {
          this.connectPromise = null;
          resolve();
        }, (err: Error & { code?: string }) => {
          this.connectPromise = null;
          if (err.code === 'UNKNOWN_OP') { resolve(); return; }
          this.teardown();
          reject(err);
        });
      });
    });
    return this.connectPromise;
  }

  /** A kapcsolat bontása (a függő kérések HELPER_DOWN-nal térnek vissza). */
  close(): void {
    this.teardown();
  }

  private teardown(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = '';
    for (const [, p] of this.pending) p.reject(new Error('HELPER_DOWN'));
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const resp = JSON.parse(line) as HelperResponse;
        const p = this.pending.get(resp.id);
        if (!p) continue;
        this.pending.delete(resp.id);
        if (resp.ok) p.resolve(resp.data);
        else {
          const err = new Error(resp.error) as Error & { code?: string };
          err.code = resp.code;
          p.reject(err);
        }
      } catch {
        // ignore malformed line
      }
    }
  }

  async call(op: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    await this.connect();
    return this.send(op, payload);
  }

  /** Egy kérés a már élő kapcsolaton — a `connect` kézfogása is ezt használja. */
  private send(op: string, payload: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const req = { id, op, ...payload } as HelperRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(JSON.stringify(req) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new Error('HELPER_DOWN'));
        }
      });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('HELPER_TIMEOUT'));
      }, 10_000);
    });
  }
}
