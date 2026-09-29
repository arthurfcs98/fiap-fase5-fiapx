import type { FiapxEvent } from '@fiapx/contracts';
import type { ProcessedMessages } from '../../src/shared/application/processed-messages';
import type { TransactionScope, UnitOfWork } from '../../src/shared/application/unit-of-work';
import type { Clock } from '../../src/shared/domain/clock';
import type {
  AccessToken,
  AccessTokenIssuer,
} from '../../src/modules/auth/domain/access-token.port';
import type { PasswordHasher } from '../../src/modules/auth/domain/password-hasher.port';
import type { User } from '../../src/modules/auth/domain/user';
import type { UserRepository } from '../../src/modules/auth/domain/user.repository';
import { EmailAlreadyRegisteredError } from '../../src/modules/auth/domain/user.repository';
import type { OutboxWriter } from '../../src/modules/outbox/domain/outbox.ports';
import type { VideoMetrics } from '../../src/modules/videos/application/ports/video.metrics';
import type { IdempotencyCache } from '../../src/modules/videos/application/ports/idempotency.cache';
import type { StatusTransition, VideoSnapshot } from '../../src/modules/videos/domain/video';
import { Video } from '../../src/modules/videos/domain/video';
import type {
  HistoryEntry,
  VideoListQuery,
  VideoPage,
  VideoRepository,
} from '../../src/modules/videos/domain/video.repository';
import {
  DuplicateIdempotencyKeyError,
  VideoOwnerNotFoundError,
} from '../../src/modules/videos/domain/video.repository';

export const USER_ID = '1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d';
export const OTHER_USER_ID = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';
export const VIDEO_ID = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
export const NOW = new Date('2026-10-10T12:00:00.000Z');

export class FixedClock implements Clock {
  constructor(public current: Date = NOW) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function aUser(overrides: Partial<User> = {}): User {
  return {
    id: USER_ID,
    name: 'Ana Souza',
    email: 'ana@example.com',
    passwordHash: 'hash:senha-forte-123',
    privacyAcceptedAt: NOW,
    privacyPolicyVersion: '2026-09-28',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function aVideo(overrides: Partial<VideoSnapshot> = {}): Video {
  return Video.restore({
    id: VIDEO_ID,
    userId: USER_ID,
    originalName: 'demo.mp4',
    sizeBytes: 1024,
    contentType: 'video/mp4',
    rawKey: `${USER_ID}/${VIDEO_ID}.mp4`,
    zipKey: null,
    status: 'QUEUED',
    attempts: 0,
    frameCount: null,
    zipSizeBytes: null,
    errorCode: null,
    errorMessage: null,
    idempotencyKey: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
    expiredAt: null,
    ...overrides,
  });
}

/** Deterministic "hash" (tests never need bcrypt's cost). */
export class FakePasswordHasher implements PasswordHasher {
  hash(plain: string): Promise<string> {
    return Promise.resolve(`hash:${plain}`);
  }

  verify(plain: string, hash: string): Promise<boolean> {
    return Promise.resolve(hash === `hash:${plain}`);
  }
}

export class FakeTokenIssuer implements AccessTokenIssuer {
  issue(userId: string): Promise<AccessToken> {
    return Promise.resolve({
      accessToken: `token-${userId}`,
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
  }
}

export class InMemoryUserRepository implements UserRepository {
  readonly users = new Map<string, User>();
  failNextInsert?: Error;

  findById(id: string): Promise<User | null> {
    return Promise.resolve(copy(this.users.get(id)));
  }

  findByEmail(email: string): Promise<User | null> {
    const user = [...this.users.values()].find(
      (u) => u.email.toLowerCase() === email.toLowerCase(),
    );
    return Promise.resolve(copy(user));
  }

  insert(user: User): Promise<void> {
    const failure = this.failNextInsert;
    this.failNextInsert = undefined;
    if (failure) return Promise.reject(failure);
    if ([...this.users.values()].some((u) => u.email === user.email)) {
      return Promise.reject(new EmailAlreadyRegisteredError());
    }
    this.users.set(user.id, { ...user });
    return Promise.resolve();
  }

  lockById(id: string): Promise<User | null> {
    return this.findById(id);
  }

  deleteById(id: string): Promise<void> {
    this.users.delete(id);
    return Promise.resolve();
  }

  existingIds(ids: readonly string[]): Promise<Set<string>> {
    return Promise.resolve(new Set(ids.filter((id) => this.users.has(id))));
  }
}

export class InMemoryVideoRepository implements VideoRepository {
  readonly videos = new Map<string, VideoSnapshot>();
  readonly history: HistoryEntry[] = [];
  /** Owners that exist (FK `videos.user_id`); `undefined` = everyone exists. */
  owners?: Set<string>;

  add(video: Video): this {
    this.videos.set(video.id, video.toSnapshot());
    return this;
  }

  insert(video: Video): Promise<void> {
    const snapshot = video.toSnapshot();
    if (this.owners && !this.owners.has(snapshot.userId)) {
      return Promise.reject(new VideoOwnerNotFoundError());
    }
    const duplicate = [...this.videos.values()].some(
      (v) =>
        v.userId === snapshot.userId &&
        snapshot.idempotencyKey !== null &&
        v.idempotencyKey === snapshot.idempotencyKey,
    );
    if (duplicate) return Promise.reject(new DuplicateIdempotencyKeyError());
    this.videos.set(video.id, snapshot);
    return Promise.resolve();
  }

  update(video: Video): Promise<void> {
    this.videos.set(video.id, video.toSnapshot());
    return Promise.resolve();
  }

  findById(id: string): Promise<Video | null> {
    return Promise.resolve(this.restore(this.videos.get(id)));
  }

  findOwnedBy(id: string, userId: string): Promise<Video | null> {
    const snapshot = this.videos.get(id);
    return Promise.resolve(snapshot?.userId === userId ? this.restore(snapshot) : null);
  }

  findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<Video | null> {
    const snapshot = [...this.videos.values()].find(
      (v) => v.userId === userId && v.idempotencyKey === idempotencyKey,
    );
    return Promise.resolve(this.restore(snapshot));
  }

  lockById(id: string): Promise<Video | null> {
    return this.findById(id);
  }

  listByOwner(query: VideoListQuery): Promise<VideoPage> {
    const all = this.ownedBy(query.userId).filter(
      (v) => !query.status || v.status === query.status,
    );
    const start = (query.page - 1) * query.limit;
    return Promise.resolve({
      items: all.slice(start, start + query.limit).map((v) => Video.restore(v)),
      total: all.length,
    });
  }

  listAllByOwner(userId: string): Promise<Video[]> {
    return Promise.resolve(this.ownedBy(userId).map((v) => Video.restore(v)));
  }

  appendHistory(videoId: string, transition: StatusTransition, at: Date): Promise<void> {
    this.history.push({
      videoId,
      fromStatus: transition.from,
      toStatus: transition.to,
      reason: transition.reason,
      createdAt: at,
    });
    return Promise.resolve();
  }

  historyOf(videoIds: readonly string[]): Promise<HistoryEntry[]> {
    return Promise.resolve(this.history.filter((entry) => videoIds.includes(entry.videoId)));
  }

  lockExpiredZips(completedBefore: Date, limit: number): Promise<Video[]> {
    const expired = [...this.videos.values()]
      .filter(
        (v) =>
          v.status === 'COMPLETED' &&
          v.zipKey !== null &&
          v.expiredAt === null &&
          v.completedAt !== null &&
          v.completedAt < completedBefore,
      )
      .slice(0, limit);
    return Promise.resolve(expired.map((v) => Video.restore(v)));
  }

  deleteAllByOwner(userId: string): Promise<string[]> {
    const ids = this.ownedBy(userId).map((v) => v.id);
    for (const id of ids) this.videos.delete(id);
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      if (ids.includes(this.history[i].videoId)) this.history.splice(i, 1);
    }
    return Promise.resolve(ids);
  }

  snapshot(id: string): VideoSnapshot | undefined {
    return this.videos.get(id);
  }

  private ownedBy(userId: string): VideoSnapshot[] {
    return [...this.videos.values()]
      .filter((v) => v.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private restore(snapshot: VideoSnapshot | undefined): Video | null {
    return snapshot ? Video.restore(snapshot) : null;
  }
}

export class RecordingOutbox implements OutboxWriter {
  readonly events: { event: FiapxEvent; aggregateId: string }[] = [];
  readonly deletedAggregates: string[] = [];

  add(event: FiapxEvent, aggregateId: string): Promise<void> {
    this.events.push({ event, aggregateId });
    return Promise.resolve();
  }

  deleteByAggregateIds(aggregateIds: readonly string[]): Promise<number> {
    this.deletedAggregates.push(...aggregateIds);
    const before = this.events.length;
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      if (aggregateIds.includes((this.events[i] as { aggregateId: string }).aggregateId)) {
        this.events.splice(i, 1);
      }
    }
    return Promise.resolve(before - this.events.length);
  }

  ofType<K extends FiapxEvent['type']>(type: K): Extract<FiapxEvent, { type: K }>[] {
    return this.events
      .map((entry) => entry.event)
      .filter((event): event is Extract<FiapxEvent, { type: K }> => event.type === type);
  }
}

export class InMemoryProcessedMessages implements ProcessedMessages {
  readonly seen = new Set<string>();
  purgedBefore?: Date;

  markProcessed(messageId: string, consumer: string): Promise<boolean> {
    const key = `${consumer}:${messageId}`;
    if (this.seen.has(key)) return Promise.resolve(false);
    this.seen.add(key);
    return Promise.resolve(true);
  }

  purgeBefore(cutoff: Date): Promise<number> {
    this.purgedBefore = cutoff;
    return Promise.resolve(0);
  }
}

/**
 * In-memory unit of work: every repository of the scope is the shared fake; a rejected `work`
 * restores the state captured at the beginning (rollback).
 */
export class FakeUnitOfWork implements UnitOfWork {
  readonly users = new InMemoryUserRepository();
  readonly videos = new InMemoryVideoRepository();
  readonly outbox = new RecordingOutbox();
  readonly processedMessages = new InMemoryProcessedMessages();
  /** Advisory locks held by "another replica". */
  readonly heldLocks = new Set<string>();
  runs = 0;

  async run<T>(work: (tx: TransactionScope) => Promise<T>): Promise<T> {
    this.runs += 1;
    const backup = {
      users: new Map(this.users.users),
      videos: new Map(this.videos.videos),
      history: [...this.videos.history],
      events: [...this.outbox.events],
      seen: new Set(this.processedMessages.seen),
    };
    try {
      return await work({
        users: this.users,
        videos: this.videos,
        outbox: this.outbox,
        processedMessages: this.processedMessages,
        tryAdvisoryLock: (name) => Promise.resolve(!this.heldLocks.has(name)),
      });
    } catch (error) {
      restore(this.users.users, backup.users);
      restore(this.videos.videos, backup.videos);
      this.videos.history.splice(0, this.videos.history.length, ...backup.history);
      this.outbox.events.splice(0, this.outbox.events.length, ...backup.events);
      this.processedMessages.seen.clear();
      for (const key of backup.seen) this.processedMessages.seen.add(key);
      throw error;
    }
  }
}

export class RecordingVideoMetrics implements VideoMetrics {
  uploadedCount = 0;
  completedCount = 0;
  readonly failures: string[] = [];

  uploaded(): void {
    this.uploadedCount += 1;
  }

  completed(): void {
    this.completedCount += 1;
  }

  failed(errorCode: string): void {
    this.failures.push(errorCode);
  }
}

export class MapIdempotencyCache implements IdempotencyCache {
  readonly entries = new Map<string, string>();

  get(userId: string, idempotencyKey: string): Promise<string | undefined> {
    return Promise.resolve(this.entries.get(`${userId}:${idempotencyKey}`));
  }

  remember(userId: string, idempotencyKey: string, videoId: string): Promise<void> {
    this.entries.set(`${userId}:${idempotencyKey}`, videoId);
    return Promise.resolve();
  }
}

function copy<T extends object>(value: T | undefined): T | null {
  return value ? { ...value } : null;
}

function restore<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}
