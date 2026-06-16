import { useCallback, useEffect, useRef, useState } from 'react';

// Drag-anywhere helper for floating popups (call overlays, etc).
//
// Usage:
//   const drag = useDraggable({ storageKey: 'agent_call_pos' });
//   <div ref={drag.ref} style={drag.style}>
//     <div {...drag.handleProps}>← drag handle (e.g. the header)</div>
//     <button>← clicks here still work, only the handle starts a drag</button>
//   </div>
//
// What it does:
//  - Pointer down on the handle records the initial mouse + element offset.
//  - Pointer move (anywhere on screen) translates the element by the delta.
//  - Pointer up commits, and (optionally) persists the position to
//    localStorage so the next reload restores it.
//  - Position is clamped to the viewport on every move + on window resize,
//    so an overlay can't end up off-screen if the user shrinks the window.
export function useDraggable({ storageKey } = {}) {
  const ref = useRef(null);
  const [pos, setPos] = useState(() => {
    if (!storageKey) return null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const v = JSON.parse(raw);
      return (typeof v?.x === 'number' && typeof v?.y === 'number') ? v : null;
    } catch { return null; }
  });
  const dragState = useRef(null); // { startX, startY, origX, origY }

  // Clamp helper — keeps at least 40px of the popup on-screen so users can't
  // strand it past the viewport edge.
  const clamp = useCallback((x, y) => {
    if (!ref.current) return { x, y };
    const r = ref.current.getBoundingClientRect();
    const minX = -r.width + 80;
    const maxX = window.innerWidth - 80;
    const minY = 0;
    const maxY = window.innerHeight - 40;
    return {
      x: Math.max(minX, Math.min(maxX, x)),
      y: Math.max(minY, Math.min(maxY, y)),
    };
  }, []);

  // Re-clamp on window resize so a shrunken viewport doesn't orphan the popup.
  useEffect(() => {
    if (!pos) return;
    const onResize = () => setPos(p => (p ? clamp(p.x, p.y) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [pos, clamp]);

  const onPointerDown = useCallback((e) => {
    // Ignore drag-start when the click was on an interactive element — buttons
    // inside the handle area should still fire normally.
    if (e.target.closest('button, a, input, textarea, select, [data-no-drag]')) return;
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: pos?.x ?? r.left,
      origY: pos?.y ?? r.top,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }, [pos]);

  const onPointerMove = useCallback((e) => {
    const d = dragState.current;
    if (!d) return;
    const nextX = d.origX + (e.clientX - d.startX);
    const nextY = d.origY + (e.clientY - d.startY);
    setPos(clamp(nextX, nextY));
  }, [clamp]);

  const onPointerUp = useCallback((e) => {
    if (!dragState.current) return;
    dragState.current = null;
    e.currentTarget?.releasePointerCapture?.(e.pointerId);
    if (storageKey && pos) {
      try { localStorage.setItem(storageKey, JSON.stringify(pos)); } catch {}
    }
  }, [pos, storageKey]);

  // Combined style: position (from drag offset) + cursor + touchAction. Built
  // so callers spread once on the outer container — no manual merging.
  const style = {
    cursor: 'grab',
    touchAction: 'none',
    ...(pos
      ? { position: 'fixed', left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
      : {}),
  };

  // Pointer handlers + the combined style above. Spread on whatever element
  // should ACT as the drag handle — typically the outer container (so the
  // whole popup is draggable from any blank area). Buttons, links, inputs,
  // textareas, selects, and elements marked [data-no-drag] are auto-skipped
  // by the pointer-down handler, so click + scroll + form interactions still
  // work normally inside the draggable region.
  const handleProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    style,
  };

  return {
    ref,
    style,        // legacy alias — apply to the container if not spreading handleProps
    handleProps,  // spread on the element that should be draggable
    isDragging: !!dragState.current,
    reset: () => {
      setPos(null);
      if (storageKey) { try { localStorage.removeItem(storageKey); } catch {} }
    },
  };
}
