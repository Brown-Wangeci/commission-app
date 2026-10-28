import { deflateSync } from "node:zlib";

/**
 * Placeholder evidence images for seed data: flat, clearly synthetic
 * compositions (a muted backdrop, a pale card standing in for a form or SIM
 * pack, a darker ground band and a diagonal hatch marking it as a
 * placeholder). Encoded as PNG with nothing but zlib.
 */
const WIDTH = 480;
const HEIGHT = 360;

const PALETTE: Array<[number, number, number]> = [
  [116, 138, 120], [138, 124, 104], [104, 124, 146], [146, 114, 112],
  [122, 132, 98], [112, 112, 138], [140, 132, 116], [98, 128, 128],
];

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC = crcTable();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function pixel(x: number, y: number, seed: number): [number, number, number] {
  const base = PALETTE[seed % PALETTE.length];
  const cardLeft = 110 + (seed % 5) * 14;
  const cardTop = 70 + (seed % 3) * 12;
  const inCard = x > cardLeft && x < cardLeft + 230 && y > cardTop && y < cardTop + 150;
  const ground = y > 270;
  const hatch = (x + y + seed * 7) % 28 < 3;
  if (inCard) return hatch ? [214, 212, 204] : [236, 234, 228];
  const shade = ground ? 0.7 : 1 - (y / HEIGHT) * 0.15;
  const tone = base.map((channel) => Math.round(channel * shade)) as [number, number, number];
  return hatch ? (tone.map((channel) => Math.min(255, channel + 18)) as [number, number, number]) : tone;
}

export function placeholderPng(seed: number): Uint8Array<ArrayBuffer> {
  const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const row = y * (WIDTH * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      const [r, g, b] = pixel(x, y, seed);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return Uint8Array.from(png);
}
