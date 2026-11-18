#!/usr/bin/env node
// Minimal stand-in for yt-dlp that speaks the same print/progress protocol the ytdlp plugin parses.
// URL behaviour: ".../fail" -> exit 1 with an ERROR line, ".../slow" -> takes ~30 s, anything else -> quick success.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const url = args.at(-1);
const home = args.find((a) => a.startsWith('home:'))?.slice(5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args.includes('--dump-single-json')) {
  console.log(JSON.stringify({ title: 'Fake Title', description: 'Fake description', duration: 93, thumbnail: 'https://example.test/t.jpg' }));
  process.exit(0);
}
if (url.endsWith('/fail')) {
  console.error('ERROR: [youtube] abc: Video unavailable');
  process.exit(1);
}

console.log('__META__' + JSON.stringify({ title: 'Fake Title', description: 'Line 1\nLine 2', duration: 93, thumbnail: 'https://example.test/t.jpg', requested_formats: [{}, {}] }));
const steps = url.endsWith('/slow') ? 300 : 4;
for (let stream = 0; stream < 2; stream++) {
  for (let i = 1; i <= steps; i++) {
    console.log(`__P__downloading|${i * 100}|${steps * 100}|NA|1000|${steps - i}`);
    await sleep(url.endsWith('/slow') ? 100 : 20);
  }
  console.log(`__P__finished|${steps * 100}|${steps * 100}|NA|1000|NA`);
}
mkdirSync(home, { recursive: true });
const file = join(home, 'Fake Title [abc].mp4');
writeFileSync(file, 'x'.repeat(2048));
console.log('__FILE__' + file);
