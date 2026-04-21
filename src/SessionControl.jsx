// SessionControl.jsx
//
// Drop-in Start/Stop button for the Race Analytics header.
// - If no active session: shows "START TRACKING" button; on tap, calls detect-session edge function
// - If active session: shows "STOP" button; on tap, calls stop-session edge function
// - Auto-refreshes on session table changes via realtime (handled by parent's useLiveSession)

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

export default function SessionControl({ session, dark }) {
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  const bdr = dark ? "#1e1e3a" : "#e0e0e0";

  const isActive = session?.is_active === true;

  const handleStart = async () => {
    setLoading(true);
    setToast(null);
    try {
      const res = await callFunction("detect-session");
      if (res.ok) {
        setToast(`Found: ${res.detected.track} ${res.detected.session_type}`);
      } else {
        setToast(res.message || res.reason || "No live session found");
      }
    } catch (err) {
      setToast(`Error: ${err.message}`);
    } finally {
      setLoading(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  const handleStop = async () => {
    // eslint-disable-next-line no-restricted-globals
    if (!confirm("Stop tracking the current session?")) return;
    setLoading(true);
    try {
      await callFunction("stop-session");
      setToast("Stopped.");
    } catch (err) {
      setToast(`Error: ${err.message}`);
    } finally {
      setLoading(false);
      setTimeout(() => setToast(null), 3000);
    }
  };

  const btnBase = {
    height: 40,
    padding: "0 10px",
    borderRadius: 6,
    border: `1px solid ${bdr}`,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.5px",
    cursor: loading ? "wait" : "pointer",
    opacity: loading ? 0.6 : 1,
  };

  return (
    <>
      {isActive ? (
        <button
          onClick={handleStop}
          disabled={loading}
          title="Stop tracking"
          style={{
            ...btnBase,
            background: "transparent",
            color: "#ef4444",
            borderColor: "#ef4444",
          }}
        >
          ⏹ STOP
        </button>
      ) : (
        <button
          onClick={handleStart}
          disabled={loading}
          title="Auto-detect and start tracking current NASCAR session"
          style={{
            ...btnBase,
            background: "#22c55e",
            color: "#000",
            borderColor: "#22c55e",
          }}
        >
          {loading ? "…" : "▶ START"}
        </button>
      )}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 20,
            left: "50%",
            transform: "translateX(-50%)",
            background: dark ? "#0d0d2a" : "#1a1a2a",
            color: "#e0e0e0",
            padding: "10px 16px",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            border: `1px solid ${bdr}`,
            zIndex: 1000,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            maxWidth: "80%",
            textAlign: "center",
          }}
        >
          {toast}
        </div>
      )}
    </>
  );
}
