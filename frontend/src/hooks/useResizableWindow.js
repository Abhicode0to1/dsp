import { useCallback, useEffect, useRef, useState } from 'react';

// Floating-window behaviour for popups: drag by a handle + resize from any of
// the 8 edges/corners, like a normal desktop window. Position + size persist to
// localStorage. Built on pointer events (works for mouse + touch) and clamps to
// the viewport so the window can't be lost off-screen.
//
// Usage:
//   const win = useResizableWindow({ storageKey: 'agent_screen_box' });
//   <div ref={win.ref} style={win.style} className="fixed bottom-4 right-4 ...">
//     {win.resizeHandles()}                         // the 8 grips
//     <header {...win.dragHandleProps}>title</header>
//     <div>body</div>
//   </div>
const MIN = { w: 280, h: 200 };
const DEFAULT = { w: 560, h: 340 };

const CURSORS = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};

export function useResizableWindow({ storageKey, defaultSize = DEFAULT, minSize = MIN } = {}) {
  const ref = useRef(null);
  const [box, setBox] = useState(() => {
    if (!storageKey) return null;
    try {
      const raw = localStorage.getItem(storageKey);
      const v = raw ? JSON.parse(raw) : null;
      if (v && typeof v.x === 'number' && typeof v.w === 'number') return v;
    } catch {}
    return null;
  });
  const op = useRef(null); // { mode, dir, startX, startY, orig:{x,y,w,h} }

  const clampBox = useCallback((b) => {
    const w = Math.max(minSize.w, b.w);
    const h = Math.max(minSize.h, b.h);
    const x = Math.max(-w + 120, Math.min(window.innerWidth - 80, b.x));
    const y = Math.max(0, Math.min(window.innerHeight - 40, b.y));
    return { x, y, w, h };
  }, [minSize.w, minSize.h]);

  const begin = useCallback((mode, dir) => (e) => {
    // Let clicks on header buttons/inputs fire normally instead of starting a drag.
    if (mode === 'drag' && e.target.closest('button, a, input, textarea, select, [data-no-drag]')) return;
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    op.current = { mode, dir, startX: e.clientX, startY: e.clientY, orig: { x: r.left, y: r.top, w: r.width, h: r.height } };
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onMove = useCallback((e) => {
    const o = op.current;
    if (!o) return;
    const dx = e.clientX - o.startX, dy = e.clientY - o.startY;
    let { x, y, w, h } = o.orig;
    if (o.mode === 'drag') { x += dx; y += dy; }
    else {
      const d = o.dir;
      if (d.includes('e')) w = o.orig.w + dx;
      if (d.includes('s')) h = o.orig.h + dy;
      if (d.includes('w')) { w = o.orig.w - dx; x = o.orig.x + dx; }
      if (d.includes('n')) { h = o.orig.h - dy; y = o.orig.y + dy; }
      // When dragging a top/left edge past the min size, pin the moving edge so
      // the window shrinks to min instead of flipping.
      if (d.includes('w') && w < minSize.w) { x = o.orig.x + (o.orig.w - minSize.w); }
      if (d.includes('n') && h < minSize.h) { y = o.orig.y + (o.orig.h - minSize.h); }
    }
    setBox(clampBox({ x, y, w, h }));
  }, [clampBox, minSize.w, minSize.h]);

  const onUp = useCallback((e) => {
    if (!op.current) return;
    op.current = null;
    try { e.currentTarget?.releasePointerCapture?.(e.pointerId); } catch {}
    setBox(b => { if (storageKey && b) { try { localStorage.setItem(storageKey, JSON.stringify(b)); } catch {} } return b; });
  }, [storageKey]);

  // Keep on-screen if the viewport shrinks.
  useEffect(() => {
    if (!box) return;
    const onResize = () => setBox(b => (b ? clampBox(b) : b));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [box, clampBox]);

  const style = box
    ? { position: 'fixed', left: box.x, top: box.y, width: box.w, height: box.h, right: 'auto', bottom: 'auto' }
    : { width: defaultSize.w, height: defaultSize.h };

  const dragHandleProps = {
    onPointerDown: begin('drag'),
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
    style: { cursor: 'grab', touchAction: 'none' },
  };

  // Data for the 8 resize grips (no JSX — this is a plain .js hook). The caller
  // maps these to <div> elements. Each is marked data-no-drag so grabbing a grip
  // resizes instead of moving the window.
  const resizeHandleList = () => {
    const defs = [
      ['n',  'top-0 left-2 right-2 h-1.5'],
      ['s',  'bottom-0 left-2 right-2 h-1.5'],
      ['e',  'right-0 top-2 bottom-2 w-1.5'],
      ['w',  'left-0 top-2 bottom-2 w-1.5'],
      ['ne', 'top-0 right-0 w-3 h-3'],
      ['nw', 'top-0 left-0 w-3 h-3'],
      ['se', 'bottom-0 right-0 w-3 h-3'],
      ['sw', 'bottom-0 left-0 w-3 h-3'],
    ];
    return defs.map(([dir, cls]) => ({
      key: dir,
      className: `absolute z-20 ${cls}`,
      style: { cursor: CURSORS[dir], touchAction: 'none' },
      'data-no-drag': true,
      onPointerDown: begin('resize', dir),
      onPointerMove: onMove,
      onPointerUp: onUp,
      onPointerCancel: onUp,
    }));
  };

  return {
    ref,
    style,
    dragHandleProps,
    resizeHandleList,
    isCustom: !!box,
    reset: () => { setBox(null); if (storageKey) { try { localStorage.removeItem(storageKey); } catch {} } },
  };
}
