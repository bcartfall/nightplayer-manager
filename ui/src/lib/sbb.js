/**
 * Reader for Nightplayer storyboard (.sbb) files. Little-endian layout:
 *   0   8   magic 53 54 4F 52 59 73 62 1A ("STORYsb\x1a")
 *   8   4   version            12  4  sheet count
 *   16  4   small image width  20  4  small image height
 *   24  8   fps (f64)          32  4  rows per sheet     36  4  columns per sheet
 *   40  24  reserved (zeros)
 *   64  20 x count  index: u32 index, u32 offset, u32 size, f64 seconds covered
 *   then a 20 byte terminator (u32 0xFFFFFFFF, u32 end offset, u32 0, f64 0), then the JPEG sheets.
 * Small images are laid out left-to-right, top-to-bottom within a sheet.
 */
export const MAGIC = [0x53, 0x54, 0x4f, 0x52, 0x59, 0x73, 0x62, 0x1a];
export const HEADER_SIZE = 64;
export const ENTRY_SIZE = 20;

export class SbbError extends Error {}

/** Width/height from a JPEG's start-of-frame marker, plus whether it has the SOI/EOI markers. */
export function inspectJpeg(b) {
  const out = { soi: b.length > 2 && b[0] === 0xff && b[1] === 0xd8, eoi: b.length > 2 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9, width: null, height: null };
  if (!out.soi) return out;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      out.height = (b[i + 5] << 8) | b[i + 6];
      out.width = (b[i + 7] << 8) | b[i + 8];
      break;
    }
    if (m === 0xda) break; // start of scan: no size found before image data
    i += 2 + len;
  }
  return out;
}

/** @param {ArrayBuffer} buffer */
export function parseSbb(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const size = bytes.length;

  if (size < HEADER_SIZE) throw new SbbError(`This file is only ${size} bytes; an .sbb header alone takes ${HEADER_SIZE}.`);
  if (!MAGIC.every((m, i) => bytes[i] === m)) throw new SbbError('Not an .sbb file: it does not start with the "STORYsb" signature.');

  const header = {
    version: dv.getUint32(8, true),
    count: dv.getUint32(12, true),
    thumbWidth: dv.getUint32(16, true),
    thumbHeight: dv.getUint32(20, true),
    fps: dv.getFloat64(24, true),
    rows: dv.getUint32(32, true),
    columns: dv.getUint32(36, true),
    reservedZero: bytes.subarray(40, 64).every((b) => b === 0),
  };
  const indexEnd = HEADER_SIZE + ENTRY_SIZE * (header.count + 1);
  if (indexEnd > size) {
    throw new SbbError(`The header announces ${header.count.toLocaleString()} sheets, but the file is too short to hold their index.`);
  }

  const interval = header.fps > 0 ? 1 / header.fps : null;
  const perSheet = header.rows * header.columns;

  const sheets = [];
  let start = 0;
  let firstFrame = 0;
  for (let i = 0; i < header.count; i++) {
    const at = HEADER_SIZE + i * ENTRY_SIZE;
    const e = { index: dv.getUint32(at, true), offset: dv.getUint32(at + 4, true), size: dv.getUint32(at + 8, true), duration: dv.getFloat64(at + 12, true) };
    const inBounds = e.offset + e.size <= size;
    const data = inBounds ? bytes.subarray(e.offset, e.offset + e.size) : new Uint8Array(0);
    const frames = interval ? Math.min(perSheet, Math.max(0, Math.round(e.duration / interval))) : 0;
    sheets.push({ ...e, inBounds, start, firstFrame, frames, jpeg: inspectJpeg(data), data });
    start += e.duration;
    firstFrame += frames;
  }

  const tAt = HEADER_SIZE + header.count * ENTRY_SIZE;
  const terminator = { marker: dv.getUint32(tAt, true), endOffset: dv.getUint32(tAt + 4, true), size: dv.getUint32(tAt + 8, true), duration: dv.getFloat64(tAt + 12, true) };

  // ---- health checks
  const checks = [];
  const add = (level, text) => checks.push({ level, text });
  add('ok', 'Signature "STORYsb" is present.');
  add(header.version === 0 ? 'ok' : 'warn', header.version === 0 ? 'Version 0, the version this viewer understands.' : `Version ${header.version}; this viewer only knows version 0, so details may be wrong.`);
  add(header.reservedZero ? 'ok' : 'warn', header.reservedZero ? 'Reserved header bytes are all zero.' : 'Reserved header bytes are not zero.');
  if (!(header.fps > 0) || !header.rows || !header.columns || !header.thumbWidth || !header.thumbHeight) {
    add('error', 'The header has a zero or invalid size, grid or frame rate, so frames cannot be placed.');
  } else {
    add('ok', `Sheets hold ${header.columns} × ${header.rows} images of ${header.thumbWidth} × ${header.thumbHeight} px.`);
  }
  add(sheets.every((s, i) => s.index === i) ? 'ok' : 'warn', sheets.every((s, i) => s.index === i) ? 'Index entries are numbered 0 to ' + (header.count - 1) + ' in order.' : 'Index entries are not numbered in order.');
  const firstOffset = indexEnd;
  const contiguous = sheets.every((s, i) => s.offset === (i === 0 ? firstOffset : sheets[i - 1].offset + sheets[i - 1].size));
  add(contiguous ? 'ok' : 'warn', contiguous ? 'Sheets are stored back to back, directly after the index.' : 'Sheets are not stored back to back after the index.');
  const oob = sheets.filter((s) => !s.inBounds).length;
  if (oob) add('error', `${oob} sheet${oob > 1 ? 's point' : ' points'} past the end of the file.`);
  add(terminator.marker === 0xffffffff ? 'ok' : 'error', terminator.marker === 0xffffffff ? 'Index ends with the 0xFFFFFFFF terminator.' : 'The index terminator (0xFFFFFFFF) is missing.');
  add(terminator.endOffset === size ? 'ok' : 'warn',
    terminator.endOffset === size ? 'Terminator end offset matches the file size.' : `Terminator says the data ends at byte ${terminator.endOffset.toLocaleString()}, but the file is ${size.toLocaleString()} bytes.`);
  const badJpeg = sheets.filter((s) => s.inBounds && !(s.jpeg.soi && s.jpeg.eoi)).length;
  add(badJpeg ? 'error' : 'ok', badJpeg ? `${badJpeg} sheet${badJpeg > 1 ? 's do' : ' does'} not look like a complete JPEG.` : 'Every sheet is a complete JPEG.');
  const wantW = header.columns * header.thumbWidth;
  const wantH = header.rows * header.thumbHeight;
  const wrongSize = sheets.filter((s) => s.jpeg.width != null && (s.jpeg.width !== wantW || s.jpeg.height !== wantH)).length;
  add(wrongSize ? 'warn' : 'ok', wrongSize ? `${wrongSize} sheet${wrongSize > 1 ? 's are' : ' is'} not ${wantW} × ${wantH} px as the grid implies.` : `Every sheet measures ${wantW} × ${wantH} px, as the grid implies.`);

  const totalFrames = sheets.reduce((n, s) => n + s.frames, 0);
  return {
    fileSize: size,
    header,
    sheets,
    terminator,
    checks,
    interval,
    totalFrames,
    covered: start,
    imageBytes: sheets.reduce((n, s) => n + s.size, 0),
    sheetPixels: { width: wantW, height: wantH },
    healthy: !checks.some((c) => c.level === 'error'),
  };
}

/** Which sheet and tile holds global frame number `n`. */
export function locateFrame(sb, n) {
  const s = sb.sheets.find((x) => n >= x.firstFrame && n < x.firstFrame + x.frames);
  if (!s) return null;
  const tile = n - s.firstFrame;
  return { sheet: s, tile, row: Math.floor(tile / sb.header.columns), col: tile % sb.header.columns, time: s.start + tile * sb.interval };
}
