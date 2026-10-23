(() => {
  const RATE = 16000;
  const WINDOW = 512;
  const HOP = 160;
  const BANDS = 24;
  const QUERY_SAMPLES = RATE;
  const THRESHOLD = 0.28;
  const WINDOW_FN = new Float32Array(WINDOW);
  const BIT_REVERSE = new Uint16Array(WINDOW);
  const TWIDDLES = {};
  for (let i = 0; i < WINDOW; i++) WINDOW_FN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WINDOW - 1));
  for (let i = 0; i < WINDOW; i++) {
    let value = i;
    let reversed = 0;
    for (let bit = 0; bit < 9; bit++) { reversed = (reversed << 1) | (value & 1); value >>= 1; }
    BIT_REVERSE[i] = reversed;
  }
  for (let length = 2; length <= WINDOW; length <<= 1) {
    const cos = new Float64Array(length / 2);
    const sin = new Float64Array(length / 2);
    for (let j = 0; j < length / 2; j++) {
      cos[j] = Math.cos(-2 * Math.PI * j / length);
      sin[j] = Math.sin(-2 * Math.PI * j / length);
    }
    TWIDDLES[length] = { cos, sin };
  }

  function decodeReference(item) {
    const raw = atob(item.data);
    const values = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const value = raw.charCodeAt(i);
      values[i] = (value > 127 ? value - 256 : value) / 127;
    }
    return { frames: item.frames, values };
  }

  const references = Object.fromEntries(Object.entries(globalThis.AdAudioReferences || {})
    .map(([name, item]) => [name, decodeReference(item)]));

  function fftMagnitudes(samples) {
    const real = Float64Array.from(samples);
    const imag = new Float64Array(WINDOW);
    for (let i = 0; i < WINDOW; i++) {
      const j = BIT_REVERSE[i];
      if (i < j) { const swap = real[i]; real[i] = real[j]; real[j] = swap; }
    }
    for (let length = 2; length <= WINDOW; length <<= 1) {
      const { cos, sin } = TWIDDLES[length];
      for (let start = 0; start < WINDOW; start += length) {
        for (let j = 0; j < length / 2; j++) {
          const even = start + j;
          const odd = even + length / 2;
          const tr = real[odd] * cos[j] - imag[odd] * sin[j];
          const ti = real[odd] * sin[j] + imag[odd] * cos[j];
          real[odd] = real[even] - tr;
          imag[odd] = imag[even] - ti;
          real[even] += tr;
          imag[even] += ti;
        }
      }
    }
    const output = new Float32Array(238);
    for (let i = 3; i < 241; i++) output[i - 3] = Math.hypot(real[i], imag[i]);
    return output;
  }

  function fingerprint(audio) {
    const frameCount = 1 + Math.floor((audio.length - WINDOW) / HOP);
    const output = new Float32Array(frameCount * BANDS);
    const windowed = new Float32Array(WINDOW);
    for (let frame = 0; frame < frameCount; frame++) {
      const offset = frame * HOP;
      for (let i = 0; i < WINDOW; i++) {
        windowed[i] = audio[offset + i] * WINDOW_FN[i];
      }
      const spectrum = fftMagnitudes(windowed);
      let mean = 0;
      for (let band = 0; band < BANDS; band++) {
        const start = Math.floor(band * spectrum.length / BANDS);
        const end = Math.floor((band + 1) * spectrum.length / BANDS);
        let sum = 0;
        for (let i = start; i < end; i++) sum += Math.log1p(spectrum[i] * 20);
        const value = sum / (end - start);
        output[frame * BANDS + band] = value;
        mean += value;
      }
      mean /= BANDS;
      let norm = 0;
      for (let band = 0; band < BANDS; band++) {
        const index = frame * BANDS + band;
        output[index] -= mean;
        norm += output[index] * output[index];
      }
      norm = Math.sqrt(norm) || 1;
      for (let band = 0; band < BANDS; band++) output[frame * BANDS + band] /= norm;
    }
    return { frames: frameCount, values: output };
  }

  function matchFeatures(query) {
    let best = { name: null, score: -1, offset: 0 };
    for (const [name, reference] of Object.entries(references)) {
      for (let offset = 0; offset <= reference.frames - query.frames; offset++) {
        let score = 0;
        for (let frame = 0; frame < query.frames; frame++) {
          const q = frame * BANDS;
          const r = (offset + frame) * BANDS;
          for (let band = 0; band < BANDS; band++) score += query.values[q + band] * reference.values[r + band];
        }
        score /= query.frames;
        if (score > best.score) best = { name, score, offset: offset * HOP / RATE };
      }
    }
    return best;
  }

  function resample(input, sourceRate) {
    const output = new Float32Array(QUERY_SAMPLES);
    const scale = (input.length - 1) / (QUERY_SAMPLES - 1);
    for (let i = 0; i < output.length; i++) {
      const position = i * scale;
      const left = Math.floor(position);
      const part = position - left;
      output[i] = input[left] * (1 - part) + input[Math.min(left + 1, input.length - 1)] * part;
    }
    return output;
  }

  function listen(stream, onMatch) {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    const silent = context.createGain();
    silent.gain.value = 0;
    const capacity = Math.ceil(context.sampleRate * 1.1);
    let samples = [];
    let received = 0;
    let lastCheck = 0;
    let stopped = false;
    processor.onaudioprocess = event => {
      if (stopped) return;
      const block = event.inputBuffer.getChannelData(0);
      samples.push(Float32Array.from(block));
      received += block.length;
      while (received > capacity && samples.length > 1) received -= samples.shift().length;
      const now = performance.now();
      if (received < context.sampleRate || now - lastCheck < 250) return;
      lastCheck = now;
      const joined = new Float32Array(received);
      let cursor = 0;
      for (const item of samples) { joined.set(item, cursor); cursor += item.length; }
      const oneSecond = joined.slice(Math.max(0, joined.length - Math.round(context.sampleRate)));
      const started = performance.now();
      const result = matchFeatures(fingerprint(resample(oneSecond, context.sampleRate)));
      result.elapsedMs = performance.now() - started;
      if (result.score >= THRESHOLD) onMatch(result);
    };
    source.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);
    return {
      stop() {
        stopped = true;
        processor.disconnect();
        source.disconnect();
        silent.disconnect();
        context.close();
      }
    };
  }

  globalThis.AdAudioFingerprint = Object.freeze({ fingerprint, matchFeatures, listen, threshold: THRESHOLD });
})();
