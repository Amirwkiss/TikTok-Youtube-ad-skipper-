import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
assert.equal(manifest.version, '0.7.0');
for (const entry of manifest.content_scripts) {
  for (const file of entry.js) assert.equal(fs.existsSync(new URL(file, import.meta.url)), true);
}

let tick;
let text = 'Обычное видео';
let src = 'clip-1';
const card = {
  get innerText() { return text; },
  querySelectorAll: () => [],
  querySelector: () => null
};
const video = {
  currentTime: 5, duration: 30, paused: false,
  get currentSrc() { return src; },
  getBoundingClientRect: () => ({ width: 300, height: 400, top: 0, bottom: 400 }),
  closest: () => card,
  textTracks: []
};
const context = {
  URL, innerHeight: 800,
  location: { href: 'https://www.tiktok.com/@test/video/1', hostname: 'www.tiktok.com', pathname: '/@test/video/1' },
  document: { querySelectorAll: selector => selector === 'video' ? [video] : [] },
  setInterval: fn => { tick = fn; },
  browser: { runtime: { sendMessage: async () => [] } }
};
vm.runInNewContext(read('content.js'), context, { filename: 'content.js' });
tick();
assert.equal(video.currentTime, 5);
text = 'Надоели мусорные скины? Заходи на Флоат Ап и делай ап-ап';
tick();
assert.equal(video.currentTime, 9);
tick();
assert.equal(video.currentTime, 9);
src = 'clip-2';
tick();
assert.equal(video.currentTime, 13);
console.log('PASS Safari: Float Up phrase skips once per clip');
