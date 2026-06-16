import { useCallback, useEffect, useRef } from 'react';

/**
 * Listen for Ctrl/Cmd+V on a typeable element and pull image attachments out of
 * the clipboard (e.g. screenshots taken with Win+Shift+S). Each image is handed
 * to `onImage(file)` as a regular `File` object so the caller can drop it into
 * whatever attachment pipeline already exists for that surface.
 *
 * Returns a callback ref — attach it to the textarea/input directly. Using a
 * callback ref (rather than receiving a `useRef` object) is critical because
 * many of our composers live inside conditionally-mounted modals: the listener
 * has to attach the moment the node appears in the DOM, not at component mount
 * time. A `useEffect`-driven approach silently misses those late mounts.
 *
 *   const pasteRef = useImagePaste(onImage);
 *   <textarea ref={pasteRef} />
 *
 * To compose with another ref you control:
 *   <textarea ref={node => { pasteRef(node); myRef.current = node; }} />
 *
 * Plain-text paste is not interfered with: the handler only calls
 * `preventDefault` when an image was actually found in the clipboard.
 */
export default function useImagePaste(onImage) {
  // Snapshot the latest callback in a ref so the attached listener always
  // calls the freshest version without us having to detach/re-attach when the
  // caller's `onImage` identity churns.
  const handlerRef = useRef(onImage);
  useEffect(() => { handlerRef.current = onImage; }, [onImage]);

  const nodeRef = useRef(null);
  const listenerRef = useRef(null);

  return useCallback((node) => {
    if (nodeRef.current && listenerRef.current) {
      nodeRef.current.removeEventListener('paste', listenerRef.current);
    }
    nodeRef.current = node;
    listenerRef.current = null;
    if (!node) return;

    const listener = (e) => {
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;

      const images = [];
      for (const item of items) {
        if (item.kind === 'file' && item.type?.startsWith('image/')) {
          const blob = item.getAsFile();
          if (!blob) continue;
          const ext = (blob.type.split('/')[1] || 'png').replace('+xml', '');
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const name = `screenshot-${stamp}.${ext}`;
          images.push(new File([blob], name, { type: blob.type, lastModified: Date.now() }));
        }
      }

      if (images.length > 0) {
        e.preventDefault();
        const fn = handlerRef.current;
        if (typeof fn === 'function') images.forEach(fn);
      }
    };
    node.addEventListener('paste', listener);
    listenerRef.current = listener;
  }, []);
}
