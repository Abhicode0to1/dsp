import { useEffect, useRef, useState } from 'react';

// Returns a normalised (0..1) audio level for the given MediaStream, updated
// roughly at the screen's refresh rate via requestAnimationFrame. Drives the
// mic-activity glow on call UIs so callers can visually confirm their mic is
// picking up sound (Bug #29).
//
// Implementation notes:
// - Uses one AudioContext + AnalyserNode per stream. Both are torn down when
//   the stream changes or the consumer unmounts, otherwise the AudioContext
//   leaks and the browser eventually rejects new ones.
// - The raw RMS is smoothed and amplified so quiet speech registers as a
//   visible level. Empirically tuned — totally silent → 0, normal speech
//   → ~0.4–0.7, shouting → ~0.9+.
// - State updates are gated by a 30 ms diff so React doesn't re-render at
//   60 fps when the level is essentially flat.
export default function useAudioLevel(stream) {
  const [level, setLevel] = useState(0);
  const rafRef = useRef(0);
  const lastEmittedRef = useRef(0);

  useEffect(() => {
    if (!stream || typeof stream.getAudioTracks !== 'function') {
      setLevel(0);
      return;
    }
    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) {
      setLevel(0);
      return;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    let ctx;
    let analyser;
    let source;
    let cancelled = false;
    try {
      ctx = new AudioCtx();
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
    } catch {
      return;
    }

    const buf = new Uint8Array(analyser.frequencyBinCount);
    let smoothed = 0;
    const tick = () => {
      if (cancelled) return;
      analyser.getByteTimeDomainData(buf);
      // RMS over the time-domain samples (each byte is centred on 128).
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      // Quiet rooms hover around 0.01–0.03 RMS; map ~0.02 → 0 and scale.
      const norm = Math.max(0, Math.min(1, (rms - 0.015) * 8));
      smoothed = smoothed * 0.6 + norm * 0.4;
      const now = performance.now();
      if (now - lastEmittedRef.current > 30) {
        lastEmittedRef.current = now;
        setLevel(smoothed);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      try { source.disconnect(); } catch {}
      try { analyser.disconnect(); } catch {}
      try { ctx.close(); } catch {}
      setLevel(0);
    };
  }, [stream]);

  return level;
}
