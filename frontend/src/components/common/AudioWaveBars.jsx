import { useMemo } from 'react';

// A tiny equalizer-style visualizer for call mic activity. Each bar idles at a
// small baseline so something is visible the moment a stream connects, then
// rises proportional to `level` (0..1). A per-bar phase offset stops them
// from moving in lockstep — gives the natural "waveform" look the customer
// asked for in bug #29.
//
//   <AudioWaveBars level={0.4} bars={5} color="bg-green-500" />
//
// Place inside any positioned wrapper. The component is purely presentational
// — pass `level` from a `useAudioLevel(stream)` call.
export default function AudioWaveBars({
  level = 0,
  bars = 5,
  color = 'bg-blue-500',
  className = '',
  barWidth = 3,
  maxHeight = 24,
  minHeight = 4,
  gap = 2,
}) {
  // Bars don't all peak at the same height — give each one a deterministic
  // "weight" so the silhouette has natural variance (like an EQ display).
  const weights = useMemo(() => {
    const out = [];
    for (let i = 0; i < bars; i++) {
      // Even-indexed bars taller, odd shorter, with a tiny offset to break the symmetry.
      const base = 0.55 + 0.4 * Math.sin((i / bars) * Math.PI);
      const jitter = ((i * 37) % 13) / 60; // ~0 to 0.21
      out.push(Math.min(1, base + jitter));
    }
    return out;
  }, [bars]);

  const v = Math.max(0, Math.min(1, level));

  return (
    <div className={`flex items-center ${className}`} style={{ gap: `${gap}px` }}>
      {weights.map((w, i) => {
        // Slight phase offset by bar index makes them move out of sync.
        const phased = Math.max(0, Math.min(1, v * w + (v > 0.05 ? (i % 2 === 0 ? 0.05 : -0.05) : 0)));
        const h = minHeight + (maxHeight - minHeight) * phased;
        const opacity = 0.45 + phased * 0.55;
        return (
          <span
            key={i}
            className={`rounded-full ${color}`}
            style={{
              width: `${barWidth}px`,
              height: `${h}px`,
              opacity,
              transition: 'height 80ms linear, opacity 80ms linear',
            }}
          />
        );
      })}
    </div>
  );
}
