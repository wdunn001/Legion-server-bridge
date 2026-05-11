/**
 * Local roster — observable peer list keyed by Trystero selfId.
 *
 * Framework-free: a tiny event emitter that React / Vue / Svelte bindings
 * subscribe to via their idiomatic stores. `@unstable-legion/react`
 * wraps this in `useSyncExternalStore`.
 *
 * Stale-peer pruning: peers absent from the most recent cap broadcasts
 * are dropped after `staleMs` (default 90s — three missed heartbeats at
 * 30s cadence).
 */
import type { MeshPeerCap, MeshRosterEntry } from './types.js';

export interface RosterOptions {
  /** Milliseconds after which a peer with no recent `cap` is removed. Default 90_000. */
  staleMs?: number;
  /** How often to run the prune sweep. Default 30_000. */
  sweepMs?: number;
}

type Listener = (snapshot: readonly MeshRosterEntry[]) => void;

export class Roster {
  private peers = new Map<string, MeshRosterEntry>();
  private listeners = new Set<Listener>();
  private staleMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotCache: readonly MeshRosterEntry[] = [];
  private dirty = true;

  constructor(opts: RosterOptions = {}) {
    this.staleMs = opts.staleMs ?? 90_000;
    const sweepMs = opts.sweepMs ?? 30_000;
    if (typeof setInterval !== 'undefined') {
      this.sweepTimer = setInterval(() => this.prune(), sweepMs);
    }
  }

  /** Update / insert a peer entry on receiving its `cap`. */
  upsert(peerId: string, cap: MeshPeerCap): void {
    this.peers.set(peerId, { ...cap, peerId, lastSeen: Date.now() });
    this.dirty = true;
    this.emit();
  }

  /** Explicit removal — Trystero `onPeerLeave` fires this. */
  remove(peerId: string): void {
    if (this.peers.delete(peerId)) {
      this.dirty = true;
      this.emit();
    }
  }

  /** Current peers, freshest-`lastSeen` first. Stable reference between writes. */
  snapshot(): readonly MeshRosterEntry[] {
    if (this.dirty) {
      this.snapshotCache = [...this.peers.values()].sort((a, b) => b.lastSeen - a.lastSeen);
      this.dirty = false;
    }
    return this.snapshotCache;
  }

  /** Subscribe; returns an unsubscribe callback. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** For consumers that need the entry without a snapshot scan. */
  get(peerId: string): MeshRosterEntry | undefined {
    return this.peers.get(peerId);
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.listeners.clear();
    this.peers.clear();
  }

  private prune(): void {
    const cutoff = Date.now() - this.staleMs;
    let changed = false;
    for (const [id, e] of this.peers) {
      if (e.lastSeen < cutoff) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.emit();
    }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}
