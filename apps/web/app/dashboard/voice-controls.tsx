"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square, Volume2 } from "lucide-react";
import { speakReplyAloud, transcribeMicrophone } from "./voice-actions";
import styles from "./workspace.module.css";

const MAX_RECORDING_SECONDS = 60;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find(
    (type) => MediaRecorder.isTypeSupported(type),
  );
}

// Push to talk: hold the button (or hold Space or Enter while it is focused) to record, release to
// send. The microphone is only open while the button is held, the browser shows its own recording
// indicator, and the audio goes to the server only to be turned into text; it is not kept.
export function PushToTalk({
  disabled,
  onHeard,
  onNotice,
  onStart,
}: {
  disabled: boolean;
  // Text that was heard clearly, ready to send like typed text.
  onHeard: (text: string) => void;
  // Text Epi was unsure about: placed in the message box for the owner to check and send.
  onNotice: (text: string, draft?: string) => void;
  onStart: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const stream = useRef<MediaStream | null>(null);
  const limit = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(limit.current);
      stream.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  async function start() {
    if (recording || busy || disabled) return;
    const mimeType = pickMime();
    if (!navigator.mediaDevices?.getUserMedia || !mimeType) {
      onNotice("This browser can't record audio here. Type your message instead.");
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onNotice(
        "I couldn't use the microphone. Allow it for this site in your browser, or type instead.",
      );
      return;
    }
    onStart();
    chunks.current = [];
    const next = new MediaRecorder(stream.current, { mimeType });
    recorder.current = next;
    next.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };
    next.onstop = () => void finish(mimeType);
    startedAt.current = Date.now();
    next.start();
    setRecording(true);
    limit.current = window.setTimeout(stop, MAX_RECORDING_SECONDS * 1000);
  }

  function stop() {
    window.clearTimeout(limit.current);
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setRecording(false);
  }

  async function finish(mimeType: string) {
    const seconds = (Date.now() - startedAt.current) / 1000;
    if (seconds < 0.5 || chunks.current.length === 0) {
      onNotice("That was too short. Hold the button while you speak.");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("audio", new Blob(chunks.current, { type: mimeType.split(";")[0] }), "recording");
      form.append("seconds", String(seconds));
      const result = await transcribeMicrophone(form);
      if (!result.ok) onNotice(result.error);
      else if (result.uncertain) {
        onNotice(
          `I'm not sure I heard that right. Check it below and press send if it's correct.`,
          result.text,
        );
      } else onHeard(result.text);
    } catch {
      onNotice("The recording didn't go through. Please try again, or type it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`${styles.micButton} ${recording ? styles.micRecording : ""}`}
      disabled={disabled || busy}
      aria-pressed={recording}
      aria-label={recording ? "Recording. Release to send" : "Hold to talk"}
      title="Hold to talk"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        void start();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          void start();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") stop();
      }}
    >
      <Mic size={18} aria-hidden="true" />
    </button>
  );
}

// Speaks Epi's newest reply when the owner has turned spoken replies on. The owner can stop it at
// any moment, and sending or recording interrupts it.
export function useSpokenReplies(enabled: boolean, latestEpiText: string | null, latestId: number) {
  const [speaking, setSpeaking] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const spokenId = useRef(0);

  function stop() {
    audio.current?.pause();
    audio.current = null;
    setSpeaking(false);
  }

  useEffect(() => {
    if (!enabled || !latestEpiText || latestId <= spokenId.current) return;
    spokenId.current = latestId;
    let cancelled = false;
    void speakReplyAloud(latestEpiText).then((result) => {
      if (cancelled || !result.ok) return;
      const player = new Audio(`data:${result.mime};base64,${result.audioBase64}`);
      audio.current = player;
      player.onended = () => setSpeaking(false);
      setSpeaking(true);
      void player.play().catch(() => setSpeaking(false));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, latestEpiText, latestId]);

  useEffect(() => stop, []);
  return { speaking, stop };
}

export function StopSpeaking({ onStop }: { onStop: () => void }) {
  return (
    <button type="button" className={styles.textButton} onClick={onStop}>
      <Volume2 size={14} aria-hidden="true" />
      <Square size={10} aria-hidden="true" />
      Stop speaking
    </button>
  );
}
