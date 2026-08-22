// Socket client used by the GUI process to talk to the privileged helper.

import * as net from 'net';
import { socketPath } from '../helper/paths';
import type { HelperRequest, HelperResponse } from '../shared/protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class HelperClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private connecting = false;

  get connected(): boolean {
    return this.socket !== null;
  }

  private connect(): Promise<void> {
    if (this.socket) return Promise.resolve();
    if (this.connecting) return Promise.reject(new Error('HELPER_DOWN'));
    this.connecting = true;
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath());
      sock.setEncoding('utf8');
      const fail = (err: Error) => {
        this.connecting = false;
        this.teardown();
        reject(err);
      };
      sock.once('error', fail);
      sock.once('connect', () => {
        sock.removeListener('error', fail);
        this.socket = sock;
        this.connecting = false;
        sock.on('data', (chunk: string) => this.onData(chunk));
        sock.on('error', () => this.teardown());
        sock.on('close', () => this.teardown());
        resolve();
      });
    });
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
