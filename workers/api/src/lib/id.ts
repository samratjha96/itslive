// ULID generation using crypto.getRandomValues (no Node.js dependency)
// Format: 01ARZ3NDEKTSV4RRFFQ69G5FAV (26 chars, time-sortable)

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number, len: number): string {
  let str = '';
  for (let i = len - 1; i >= 0; i--) {
    str = ENCODING[now % ENCODING_LEN] + str;
    now = Math.floor(now / ENCODING_LEN);
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => ENCODING[b % ENCODING_LEN])
    .join('');
}

export function ulid(): string {
  return encodeTime(Date.now(), TIME_LEN) + encodeRandom(RANDOM_LEN);
}
