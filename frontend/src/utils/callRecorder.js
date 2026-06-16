// Browser-side call recording helper.
//
// Mixes the agent's local microphone with the remote peer's audio via
// Web Audio API, then captures the mixed stream with MediaRecorder.
//
// Usage:
//   const rec = startCallRecording({ localStream });        // start when getUserMedia ready
//   rec.attachRemote(remoteStream);                         // when pc.ontrack fires
//   const blob = await rec.stop();                          // when call ends
//   // upload blob as multipart with ref_type='call_recording'
//
// All recording errors are swallowed (logged only) — a failed recording must
// never break the actual call.

const MIME = 'audio/webm;codecs=opus';

export function startCallRecording({ localStream } = {}) {
  console.log('[CallRecorder] startCallRecording invoked');
  if (typeof MediaRecorder === 'undefined') {
    console.warn('[CallRecorder] MediaRecorder API not available in this browser');
    return makeNoop();
  }
  if (!MediaRecorder.isTypeSupported?.(MIME)) {
    console.warn(`[CallRecorder] mime type ${MIME} not supported, trying fallback`);
    // Try fallback formats
    const fallbacks = ['audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
    const supported = fallbacks.find(m => MediaRecorder.isTypeSupported(m));
    if (!supported) {
      console.warn('[CallRecorder] no supported audio mime type — recording disabled');
      return makeNoop();
    }
    console.log('[CallRecorder] using fallback mime:', supported);
    return startWithMime(localStream, supported);
  }
  if (!localStream) {
    console.warn('[CallRecorder] no localStream provided — skipping recording');
    return makeNoop();
  }
  return startWithMime(localStream, MIME);
}

function startWithMime(localStream, mime) {
  let ctx, dest, recorder;
  let localSrc = null;
  let remoteSrc = null;
  const chunks = [];

  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    dest = ctx.createMediaStreamDestination();
    localSrc = ctx.createMediaStreamSource(localStream);
    localSrc.connect(dest);

    recorder = new MediaRecorder(dest.stream, { mimeType: mime });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
        // Log every 10th chunk to avoid spamming console on long calls
        if (chunks.length % 10 === 0) {
          console.log(`[CallRecorder] ${chunks.length} chunks buffered (~${Math.round(chunks.reduce((s, c) => s + c.size, 0) / 1024)} KB total)`);
        }
      }
    };
    recorder.onerror = (e) => console.error('[CallRecorder] recorder error event:', e?.error?.message || e);
    recorder.start(1000); // emit a chunk every second so we lose at most 1s on crash
    console.log(`[CallRecorder] started (${mime}, state=${recorder.state})`);
  } catch (err) {
    console.error('[CallRecorder] init failed — recording disabled:', err?.message || err);
    // Clean up partial state to avoid leaks (AudioContext, source node)
    try { localSrc?.disconnect(); } catch {}
    try { ctx?.close(); } catch {}
    return makeNoop();
  }

  return {
    attachRemote(remoteStream) {
      if (!remoteStream || remoteSrc) return;
      try {
        remoteSrc = ctx.createMediaStreamSource(remoteStream);
        remoteSrc.connect(dest);
      } catch (err) {
        console.warn('[CallRecorder] attachRemote failed:', err?.message || err);
      }
    },

    stop() {
      return new Promise((resolve) => {
        try {
          if (recorder.state === 'inactive') {
            cleanup();
            return resolve(null);
          }
          recorder.onstop = () => {
            const blob = chunks.length ? new Blob(chunks, { type: 'audio/webm' }) : null;
            cleanup();
            resolve(blob);
          };
          recorder.stop();
        } catch (err) {
          console.warn('[CallRecorder] stop failed:', err?.message || err);
          cleanup();
          resolve(null);
        }
      });
    },

    cancel() {
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch {}
      cleanup();
    },
  };

  function cleanup() {
    try { localSrc?.disconnect(); } catch {}
    try { remoteSrc?.disconnect(); } catch {}
    try { ctx?.close(); } catch {}
  }
}

function makeNoop() {
  return {
    attachRemote() {},
    stop: async () => null,
    cancel() {},
  };
}

// Upload a recording blob via the existing /api/attachments endpoint.
// Returns the attachment row or null if upload failed.
export async function uploadCallRecording({ blob, callId, uploadAttachment }) {
  console.log(`[CallRecorder] uploadCallRecording called — blob=${blob ? blob.size + ' bytes' : 'null'}, callId=${callId}`);
  if (!blob || !callId || !uploadAttachment) {
    console.warn('[CallRecorder] missing args — blob, callId, or uploadAttachment');
    return null;
  }
  try {
    const fd = new FormData();
    // Text fields MUST come before the file field so multer's fileFilter can
    // see req.body.ref_type when it processes the file part.
    fd.append('ref_type', 'call_recording');
    fd.append('ref_id', String(callId));
    fd.append('file', blob, `call-${callId}-${Date.now()}.webm`);
    console.log(`[CallRecorder] POSTing /api/attachments with ${blob.size} bytes for call ${callId}`);
    const res = await uploadAttachment(fd);
    console.log('[CallRecorder] upload response:', res?.status, res?.data);
    return res?.data?.attachment || null;
  } catch (err) {
    console.error('[CallRecorder] upload FAILED:', {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data,
    });
    return null;
  }
}
