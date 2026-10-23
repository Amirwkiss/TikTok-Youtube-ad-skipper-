import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const run = (name, context) => vm.runInNewContext(read(name), context, { filename: name });

{
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  for (const entry of manifest.content_scripts) {
    for (const file of entry.js) assert.equal(fs.existsSync(new URL(file, import.meta.url)), true);
  }
  assert.equal(fs.existsSync(new URL(manifest.background.service_worker, import.meta.url)), true);
  assert.equal(fs.existsSync(new URL('offscreen.html', import.meta.url)), true);
  assert.equal(fs.existsSync(new URL('offscreen.js', import.meta.url)), true);
  console.log('PASS manifest: content scripts and service worker exist');
}

{
  let listener;
  let requestedUrl = '';
  const context = {
    chrome: {
      action: { onClicked: { addListener: () => {} } },
      runtime: { onMessage: { addListener: fn => { listener = fn; } }, getURL: path => `chrome-extension://test/${path}` }
    },
    fetch: async url => {
      requestedUrl = url;
      return { ok: true, json: async () => [{ segment: [10, 20] }] };
    },
    AbortSignal
  };
  run('background.js', context);
  assert.equal(listener({ type: 'segments', videoId: 'bad' }, {}, () => {}), undefined);
  const result = await new Promise(resolve => listener({ type: 'segments', videoId: 'abcdefghijk' }, {}, resolve));
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0][1], 20);
  assert.match(requestedUrl, /videoID=abcdefghijk/);
  console.log('PASS background: valid ID requests segments; invalid ID rejected');
}

{
  let listener;
  let attempts = 0;
  let injected;
  let forwarded;
  let resolveBadge;
  const badgeSet = new Promise(resolve => { resolveBadge = resolve; });
  const context = {
    chrome: {
      action: {
        onClicked: { addListener() {} },
        async setBadgeText({ text }) { if (text === 'SKIP') resolveBadge(); },
        async setBadgeBackgroundColor() {}, async setTitle() {}
      },
      runtime: { onMessage: { addListener: fn => { listener = fn; } }, getURL: path => `chrome-extension://test/${path}` },
      tabs: { async get() { return { url: 'https://www.tiktok.com/@test/video/123' }; }, async sendMessage(_tabId, message) { attempts++; forwarded = message; if (attempts === 1) throw new Error('Receiving end does not exist'); return { ok: true }; } },
      scripting: { async executeScript(details) { injected = details; } }
    }
  };
  run('background.js', context);
  listener({ type: 'speech-brand', tabId: 42, context: { key: '|clip-1', time: 5 } }, { url: 'chrome-extension://test/offscreen.html' }, () => {});
  await badgeSet;
  assert.equal(attempts, 2);
  assert.equal(injected.target.tabId, 42);
  assert.deepEqual(Array.from(injected.files), ['detector.js', 'audio-references.js', 'audio-fingerprint.js', 'tiktok.js']);
  assert.equal(forwarded.context.key, '|clip-1');
  console.log('PASS background: missing TikTok listener is re-injected and skip retried');
}

{
  const context = { globalThis: {}, atob };
  context.globalThis = context;
  run('audio-references.js', context);
  run('audio-fingerprint.js', context);
  for (const [expected, item] of Object.entries(context.AdAudioReferences)) {
    const raw = atob(item.data);
    const frameCount = 1 + Math.floor((16000 - 512) / 160);
    const values = new Float32Array(frameCount * 24);
    for (let i = 0; i < values.length; i++) {
      const value = raw.charCodeAt(i);
      values[i] = (value > 127 ? value - 256 : value) / 127;
    }
    const result = context.AdAudioFingerprint.matchFeatures({ frames: frameCount, values });
    assert.equal(result.name, expected);
    assert.ok(result.score > 0.9);
  }
  console.log('PASS audio fingerprint: both bundled references match one-second slices');
}

{
  let click;
  let sent;
  let badge;
  const context = {
    chrome: {
      action: {
        onClicked: { addListener: fn => { click = fn; } },
        async setBadgeText({ text }) { badge = text; },
        async setBadgeBackgroundColor() {}, async setTitle() {}
      },
      tabCapture: {
        async getCapturedTabs() { return []; },
        async getMediaStreamId() { return 'stream'; }
      },
      runtime: {
        onMessage: { addListener() {} },
        getURL: path => `chrome-extension://test/${path}`,
        async getContexts() { return [{ contextType: 'OFFSCREEN_DOCUMENT' }]; },
        async sendMessage(message) { sent = message; return { ok: true, mode: 'local' }; }
      },
      storage: { local: { async get() { return {}; } } },
      tabs: { async sendMessage() {} }
    }
  };
  run('background.js', context);
  await click({ id: 7, url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  assert.equal(sent.type, 'start');
  assert.equal(sent.tabId, 7);
  assert.equal(badge, 'ON');
  console.log('PASS background: YouTube toolbar click starts speech capture');
}

{
  const context = { globalThis: {} };
  run('detector.js', context);
  const detector = context.globalThis.AdDetector;
  assert.equal(detector.hasBrand('Реклама Floatup'), true);
  assert.equal(detector.hasBrand('заходи на Float Up и делай ап-ап'), true);
  assert.equal(detector.hasBrand('Надоели мусорные скины? Заходи на Флоат Ап и делай ап-ап'), true);
  assert.equal(detector.hasBrand('надоели мусорные скины'), true);
  assert.equal(detector.hasBrand('заходи на флоат ап'), true);
  assert.equal(detector.hasBrand('заходи на и делай ап ап'), true);
  assert.equal(detector.hasBrand('флотап'), true);
  assert.equal(detector.hasBrand('флоуап'), true);
  assert.equal(detector.hasBrand('Musor Drop'), true);
  assert.equal(detector.hasBrand('мусор дроп, там твой высокий шанс на дроп'), true);
  assert.equal(detector.hasBrand('там твой высокий шанс'), true);
  assert.equal(detector.hasBrand('там ваш высокий шанс на дроб'), true);
  assert.equal(detector.hasBrand('Skin.Club'), true);
  assert.equal(detector.hasBrand('GGDrop'), true);
  assert.equal(detector.hasBrand('ForceDrop'), true);
  assert.equal(detector.hasBrand('Key-Drop'), true);
  assert.equal(detector.hasBrand('скин клаб'), true);
  assert.equal(detector.hasBrand('Hellcase'), true);
  assert.equal(detector.hasBrand('хелл кейс'), true);
  assert.equal(detector.hasBrand('форс дроп'), true);
  assert.equal(detector.hasBrand('кей дроп'), true);
  assert.equal(detector.hasBrand('у тебя высокий шанс на победу'), false);
  assert.equal(detector.hasBrand('отдельный ролик Drop'), false);
  assert.equal(detector.hasBrand('обычный ролик про дроп'), false);
  assert.equal(detector.hasBrand('обычный ролик про музыку'), false);
  assert.equal(detector.isAdLabel(' Реклама '), true);
  const video = { currentTime: 12, duration: 30 };
  assert.equal(detector.seekFourSeconds(video), true);
  assert.equal(video.currentTime, 16);
  video.currentTime = 29;
  assert.equal(detector.seekFourSeconds(video), true);
  assert.equal(video.currentTime, 29.9);
  assert.equal(detector.seekFourSeconds(video), false);
  console.log('PASS detector: brand, label, four-second seek, end boundary');
}

{
  let tick;
  let onMessage;
  let recognition;
  const track = { readyState: 'live', stop() {} };
  class Speech {
    static async available() { return 'available'; }
    constructor() { recognition = this; }
    start(receivedTrack) { assert.equal(receivedTrack, track); }
    abort() {}
  }
  Speech.prototype.processLocally = false;
  const video = {
    currentTime: 5, duration: 60, paused: false, currentSrc: 'youtube-video-1',
    captureStream: () => ({ getAudioTracks: () => [track] })
  };
  const context = {
    URL, Date, SpeechRecognition: Speech,
    location: { href: 'https://www.youtube.com/watch?v=abcdefghijk' },
    document: {
      querySelector: selector => selector === 'video.html5-main-video' ? video : null,
      querySelectorAll: () => []
    },
    chrome: {
      runtime: {
        onMessage: { addListener: fn => { onMessage = fn; } },
        sendMessage: (_message, reply) => reply({ segments: [] })
      },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } }
    },
    setInterval: fn => { tick = fn; }
  };
  context.globalThis = context;
  run('detector.js', context);
  run('youtube.js', context);
  await new Promise(resolve => setImmediate(resolve));
  tick();
  recognition.onresult({ resultIndex: 0, results: [[{ transcript: 'Заходи на Флоат Ап и делай ап ап' }]] });
  assert.equal(video.currentTime, 9);
  let reply;
  onMessage({ type: 'speech-context' }, {}, result => { reply = result; });
  assert.equal(reply.key, 'abcdefghijk|youtube-video-1');
  video.currentSrc = 'youtube-video-2';
  onMessage({ type: 'speech-brand', context: reply }, {}, result => { reply = result; });
  assert.equal(reply.stale, true);
  assert.equal(video.currentTime, 9);
  console.log('PASS YouTube: spoken Float Up and stale video guard');
}

{
  let tick;
  let caption = '';
  const video = { currentTime: 15, duration: 120, paused: false };
  const context = {
    URL, location: { href: 'https://www.youtube.com/watch?v=abcdefghijk' },
    document: {
      querySelector: selector => selector === 'video.html5-main-video' ? video : null,
      querySelectorAll: () => caption ? [{ textContent: caption }] : []
    },
    chrome: { runtime: { sendMessage: (_message, reply) => reply({ segments: [[10, 20]] }) } },
    setInterval: fn => { tick = fn; }, Date
  };
  context.globalThis = context;
  run('detector.js', context);
  run('youtube.js', context);
  tick();
  assert.equal(video.currentTime, 20);
  video.currentTime = 30;
  caption = 'Посмотрите Floatup';
  tick();
  assert.equal(video.currentTime, 34);
  tick();
  assert.equal(video.currentTime, 34);
  console.log('PASS YouTube: SponsorBlock segment and unmarked caption trigger');
}

{
  let tick;
  let onMessage;
  let text = 'Сегодня просто видео';
  const card = {
    get innerText() { return text; },
    querySelectorAll: () => [], querySelector: () => null
  };
  const video = {
    currentTime: 8, duration: 30, paused: false, currentSrc: 'clip-1',
    getBoundingClientRect: () => ({ width: 300, height: 500, top: 0, bottom: 500 }),
    closest: () => card,
    textTracks: [{ activeCues: [] }]
  };
  const context = {
    document: { querySelectorAll: selector => selector === 'video' ? [video] : [] }, innerHeight: 800,
    setInterval: fn => { tick = fn; },
    chrome: {
      runtime: { onMessage: { addListener: fn => { onMessage = fn; } } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } }
    }
  };
  context.globalThis = context;
  run('detector.js', context);
  run('tiktok.js', context);
  tick();
  assert.equal(video.currentTime, 8);
  text = 'Реклама Floatup';
  tick();
  assert.equal(video.currentTime, 12);
  tick();
  assert.equal(video.currentTime, 12);
  video.currentTime = 18;
  let seekReply;
  onMessage({ type: 'speech-brand' }, {}, result => { seekReply = result; });
  assert.equal(video.currentTime, 22);
  assert.equal(seekReply.ok, true);
  video.currentTime = 12;
  video.currentSrc = 'clip-2';
  text = 'Сегодня просто видео';
  video.textTracks[0].activeCues = [{ text: 'заходи на Float Up и делай up up' }];
  tick();
  assert.equal(video.currentTime, 16);
  video.currentSrc = 'clip-3';
  onMessage({ type: 'speech-brand' }, {}, result => { seekReply = result; });
  assert.equal(video.currentTime, 20);
  assert.equal(seekReply.ok, true);
  onMessage({ type: 'speech-brand' }, {}, result => { seekReply = result; });
  assert.equal(video.currentTime, 20);
  assert.equal(seekReply.ok, false);
  video.currentTime = 24;
  onMessage({ type: 'speech-brand' }, {}, result => { seekReply = result; });
  assert.equal(video.currentTime, 28);
  assert.equal(seekReply.ok, true);
  video.currentTime = 10;
  onMessage({ type: 'speech-brand', context: { key: '|other-clip', time: 8 } }, {}, result => { seekReply = result; });
  assert.equal(video.currentTime, 10);
  assert.equal(seekReply.ok, false);
  let speechContext;
  onMessage({ type: 'speech-context' }, {}, result => { speechContext = result; });
  assert.equal(speechContext.key, '|clip-3');
  video.currentTime = 19;
  onMessage({ type: 'speech-brand', context: speechContext }, {}, result => { seekReply = result; });
  assert.equal(video.currentTime, 19);
  assert.equal(seekReply.ok, false);
  console.log('PASS TikTok: repeated spoken ads in one video skip with cooldown');
}

{
  let tick;
  let recognition;
  let installed = false;
  const track = { readyState: 'live', stop() {} };
  class Speech {
    static async available() { return 'downloadable'; }
    static async install() { installed = true; return true; }
    constructor() { recognition = this; }
    start(receivedTrack) { assert.equal(receivedTrack, track); }
    abort() {}
  }
  Speech.prototype.processLocally = false;
  const card = { innerText: 'Обычное описание', querySelectorAll: () => [], querySelector: () => null };
  const video = {
    currentTime: 7, duration: 25, paused: false, currentSrc: 'clip-voice',
    getBoundingClientRect: () => ({ width: 300, height: 500, top: 0, bottom: 500 }),
    closest: () => card, captureStream: () => ({ getAudioTracks: () => [track] })
  };
  const context = {
    SpeechRecognition: Speech, Date, innerHeight: 800,
    document: { querySelectorAll: selector => selector === 'video' ? [video] : [] },
    setInterval: fn => { tick = fn; },
    chrome: {
      runtime: { onMessage: { addListener: () => {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } }
    }
  };
  context.globalThis = context;
  run('detector.js', context);
  run('tiktok.js', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(installed, true);
  tick();
  assert.equal(recognition.processLocally, true);
  recognition.onresult({ resultIndex: 0, results: [[{ transcript: 'заходи на Float Up и делай up up' }]] });
  assert.equal(video.currentTime, 11);
  tick();
  assert.equal(video.currentTime, 11);
  console.log('PASS TikTok: local speech recognition seeks 4s on spoken Float Up');
}

{
  let tick;
  let recognition;
  const track = { readyState: 'live', stop() {} };
  class Speech {
    static async available() { return 'unavailable'; }
    constructor() { recognition = this; }
    start(receivedTrack) { assert.equal(receivedTrack, track); }
    abort() {}
  }
  Speech.prototype.processLocally = false;
  const card = { innerText: 'Обычное видео', querySelectorAll: () => [], querySelector: () => null };
  const video = {
    currentTime: 5, duration: 30, paused: false, currentSrc: 'clip-auto',
    getBoundingClientRect: () => ({ width: 300, height: 500, top: 0, bottom: 500 }),
    closest: () => card, captureStream: () => ({ getAudioTracks: () => [track] })
  };
  const context = {
    SpeechRecognition: Speech, Date, innerHeight: 800,
    document: { querySelectorAll: selector => selector === 'video' ? [video] : [] },
    setInterval: fn => { tick = fn; },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: { get: async () => ({ allowCloudSpeech: true }) }, onChanged: { addListener() {} } }
    }
  };
  context.globalThis = context;
  run('detector.js', context);
  run('tiktok.js', context);
  await new Promise(resolve => setImmediate(resolve));
  tick();
  assert.equal(recognition.processLocally, false);
  video.currentSrc = 'clip-next';
  recognition.onresult({ resultIndex: 0, results: [[{ transcript: 'твой высокий шанс' }]] });
  assert.equal(video.currentTime, 5);
  tick();
  recognition.onresult({ resultIndex: 0, results: [[{ transcript: 'твой высокий шанс' }]] });
  assert.equal(video.currentTime, 9);
  console.log('PASS TikTok: automatic cloud recognition ignores late text from previous video');
}

{
  let listener;
  let recognition;
  const messages = [];
  const track = { readyState: 'live', stop() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Speech {
    static async available() { return 'available'; }
    constructor() { recognition = this; }
    start(receivedTrack) { assert.equal(receivedTrack, track); }
    abort() {}
  }
  Speech.prototype.processLocally = false;
  class AudioContextMock {
    createMediaStreamSource(receivedStream) {
      assert.equal(receivedStream, stream);
      return { connect: () => {} };
    }
    createAnalyser() { return { fftSize: 1024, connect() {}, getFloatTimeDomainData(samples) { samples.fill(0.01); } }; }
    async close() {}
  }
  const context = {
    SpeechRecognition: Speech, AudioContext: AudioContextMock, clearTimeout, setTimeout, setInterval: () => 1, clearInterval() {}, Float32Array,
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    chrome: { runtime: {
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: message => {
        if (message.type === 'speech-context-request') return Promise.resolve({ key: '|clip-voice', time: 7 });
        messages.push(message);
      }
    } }
  };
  context.globalThis = context;
  run('detector.js', context);
  run('offscreen.js', context);
  const reply = await new Promise(resolve => listener({ target: 'offscreen', type: 'start', streamId: 'test', tabId: 42 }, {}, resolve));
  assert.equal(reply.ok, true);
  assert.equal(reply.mode, 'local');
  assert.equal(recognition.processLocally, true);
  assert.equal(recognition.maxAlternatives, 5);
  recognition.onspeechstart();
  await recognition.onresult({ resultIndex: 0, results: [[
    { transcript: 'там высокий шанс' },
    { transcript: 'там мусор дроп' }
  ]] });
  assert.equal(messages[0].type, 'speech-diagnostic');
  assert.equal(messages[0].state, 'transcript');
  assert.equal(messages[1].type, 'speech-brand');
  assert.equal(messages[1].tabId, 42);
  assert.equal(messages[1].context.key, '|clip-voice');
  await new Promise(resolve => listener({ target: 'offscreen', type: 'stop' }, {}, resolve));
  console.log('PASS tab audio: local recognizer forwards spoken brand to TikTok tab');
}

{
  let listener;
  let recognition;
  const track = { readyState: 'live', stop() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Speech {
    static async available() { return 'unavailable'; }
    constructor() { recognition = this; }
    start() {}
    abort() {}
  }
  Speech.prototype.processLocally = false;
  class AudioContextMock {
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 1024, connect() {}, getFloatTimeDomainData() {} }; }
    async close() {}
  }
  const context = {
    SpeechRecognition: Speech, AudioContext: AudioContextMock, clearTimeout, setTimeout, setInterval: () => 1, clearInterval() {}, Float32Array,
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    chrome: { runtime: {
      onMessage: { addListener: fn => { listener = fn; } }, sendMessage() {}
    } }
  };
  context.globalThis = context;
  run('detector.js', context);
  run('offscreen.js', context);
  const denied = await new Promise(resolve => listener({ target: 'offscreen', type: 'start', streamId: 'test', tabId: 42, allowCloud: false }, {}, resolve));
  assert.equal(denied.ok, false);
  assert.equal(recognition, undefined);
  const allowed = await new Promise(resolve => listener({ target: 'offscreen', type: 'start', streamId: 'test', tabId: 42, allowCloud: true }, {}, resolve));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.mode, 'cloud');
  assert.equal(recognition.processLocally, false);
  await new Promise(resolve => listener({ target: 'offscreen', type: 'stop' }, {}, resolve));
  console.log('PASS cloud fallback: unavailable local pack requires explicit consent');
}
