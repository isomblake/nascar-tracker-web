// SessionControl.jsx
//
// Bottom-of-screen action bar for Start/Stop.
// Fixed to bottom of viewport = thumb zone, clear of iPhone notch/Dynamic Island.
// Respects iOS safe-area insets so it sits above the home indicator.
//
// - No active session: full-width green ▶ START TRACKING
// - Active session: full-width red ■ STOP TRACKING
// Toast rises above the bar.

import { useState } from "react";

const FN_BASE = `${process.env.REACT_APP_SUPABASE_URL}/functions/v1`;
const ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY;

async function callFunction(name, body = {}) {
  const r = await fetch(`${FN_BASE}/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ANON_KEY}`,
      apikey: ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return await r.json();
}

export default function SessionControl({ session, dark, onAfterAction }) {
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  const isActive = session?.is_active === true;

  const showToast = (msg, ms = 3500) => {
    setToast(msg);
    setTimeout(() => setToast(null), ms);
  };

  const handleStart = async () => {
    setLoading(true);
    try {
      const res = await callFunction("detect-session");
      if (res.ok) {
        showToast(`✓ ${res.detected.track} · ${res.detected.session_type}`);
      } else {
        showToast(res.message || res.reason || "No live session");
      }
      if (onAfterAction) onAfterAction();
    } catch (err) {
      showToast(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    // eslint-disable-next-line no-restricted-globals
    if (!confirm("Stop tracking the current session?")) return;
    setLoading(true);
    try {
      await callFunction("stop-session");
      showToast("Stopped");
      if (onAfterAction) onAfterAction();
    } catch (err) {
      showToast(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const barHeight = 56;
  const bg = dark ? "#08081a" : "#ffffff";
  const bdr = dark ? "#1e1e3a" : "#e0e0e0";

  return (
    <>
      {/* Spacer so page content isn't hidden under the fixed bar */}
      <div
        aria-hidden="true"
        style={{
          height: `calc(${barHeight}px + env(safe-area-inset-bottom, 0px) + 12px)`,
        }}
      />

      {/* Toast — above the bar */}
      {toast && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: `calc(${barHeight + 20}px + env(safe-area-inset-bottom, 0px))`,
            transform: "translateX(-50%)",
            background: dark ? "#0d0d2a" : "#1a1a2a",
            color: "#e0e0e0",
            padding: "10px 16px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            border: `1px solid ${bdr}`,
            zIndex: 1001,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            maxWidth: "80vw",
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          {toast}
        </div>
      )}

      {/* Bottom action bar */}
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          padding: `6px 12px calc(6px + env(safe-area-inset-bottom, 0px)) 12px`,
          background: bg,
          borderTop: `1px solid ${bdr}`,
          zIndex: 1000,
          boxShadow: "0 -2px 10px rgba(0,0,0,0.25)",
        }}
      >
        <button
          onClick={isActive ? handleStop : handleStart}
          disabled={loading}
          aria-label={isActive ? "Stop tracking" : "Start tracking"}
          style={{
            width: "100%",
            height: barHeight,
            borderRadius: 10,
            border: "none",
            fontSize: 15,
            fontWeight: 800,
            letterSpacing: "0.8px",
            cursor: loading ? "wait" : "pointer",
            opacity: loading ? 0.7 : 1,
            background: isActive ? "#ef4444" : "#22c55e",
            color: isActive ? "#fff" : "#000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            WebkitTapHighlightColor: "transparent",
            touchAction: "manipulation",
          }}
        >
          {loading ? (
            "…"
          ) : isActive ? (
            <>
              <span style={{ fontSize: 14 }}>■</span>
              <span>STOP TRACKING</span>
            </>
          ) : (
            <>
              <span style={{ fontSize: 14 }}>▶</span>
              <span>START TRACKING</span>
            </>
          )}
        </button>
      </div>
    </>
  );
}
