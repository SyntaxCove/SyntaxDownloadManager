import { z } from "zod";

/**
 * ULID identifiers (Crockford base32, 26 chars: 10-char timestamp + 16-char randomness).
 * Implemented identically in Rust (dc-protocol::ids) so both sides can generate IDs.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" as const;
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ULID_LEN = TIME_LEN + RANDOM_LEN; // 26

export const Ulid = z
  .string()
  .length(ULID_LEN)
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "not a Crockford base32 ULID");
export type Ulid = z.infer<typeof Ulid>;

function encodeTime(now: number): string {
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    out = CROCKFORD[mod] + out;
    now = (now - mod) / ENCODING_LEN;
  }
  return out;
}

function randomChars(rand: () => number): string {
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) out += CROCKFORD[Math.floor(rand() * ENCODING_LEN)];
  return out;
}

/**
 * Monotonic factory: within the same millisecond the random part is incremented so that
 * ULIDs generated in one process are always strictly increasing (stable sort order).
 */
export function createUlidFactory(seedRandom: () => number = Math.random): () => string {
  let lastTime = -1;
  let lastRandom: number[] = [];

  const incrementRandom = (digits: number[]): number[] => {
    const next = [...digits];
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i]! < ENCODING_LEN - 1) {
        next[i] = next[i]! + 1;
        return next;
      }
      next[i] = 0;
    }
    return next.map(() => Math.floor(seedRandom() * ENCODING_LEN));
  };

  return () => {
    const time = Date.now();
    if (time === lastTime) lastRandom = incrementRandom(lastRandom);
    else {
      lastRandom = Array.from({ length: RANDOM_LEN }, () => Math.floor(seedRandom() * ENCODING_LEN));
      lastTime = time;
    }
    return (
      encodeTime(time) + lastRandom.map((d) => CROCKFORD[d] ?? "0").join("")
    );
  };
}

export const newUlid: () => string = createUlidFactory();

/** Decode a ULID's timestamp part to epoch milliseconds. */
export function ulidTime(id: string): number | null {
  if (!Ulid.safeParse(id).success) return null;
  let time = 0;
  for (const ch of id.slice(0, TIME_LEN)) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) return null;
    time = time * ENCODING_LEN + idx;
  }
  return time;
}

/** Crockford-normalize common misreads (i→1, l→1, o→0, u→v) before validation. */
export function normalizeUlid(input: string): string {
  return input
    .toUpperCase()
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
}
