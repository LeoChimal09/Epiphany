"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  Bot,
  CalendarDays,
  CircleAlert,
  CircleCheck,
  Lightbulb,
  ListChecks,
  Plus,
  SendHorizontal,
  Sparkles,
  UserRound,
} from "lucide-react";
import type { AssistantReply } from "@epiphany/core/assistant";
import { PushToTalk, StopSpeaking, useSpokenReplies } from "./voice-controls";
import styles from "./workspace.module.css";

export interface ChatMessage {
  id: number;
  role: "user" | "epi";
  text: string;
  outcome?: AssistantReply["outcome"];
  changed?: boolean;
}

export type AssistantSetup = "ready" | "needs_key" | "misconfigured";

const SUGGESTIONS = [
  { text: "What's on my plate?", icon: ListChecks },
  { text: "What does my week look like?", icon: CalendarDays },
  { text: "Add a task: read chapter 4 by Friday", icon: Plus },
  { text: "Idea: an app that tracks workouts against free time", icon: Lightbulb },
];
const MAX_LENGTH = 8000;

function SetupHelp({ setup }: { setup: Exclude<AssistantSetup, "ready"> }) {
  return (
    <div className={styles.chatSetup} role="status">
      <CircleAlert size={18} aria-hidden="true" />
      <div>
        <strong>
          {setup === "needs_key"
            ? "Epi needs an OpenAI key to understand free-form messages."
            : "Epi's AI settings need attention."}
        </strong>
        <p>
          {setup === "needs_key"
            ? "Add OPENAI_API_KEY to the project .env file, then restart the dashboard. The model, prices, and budget already have defaults."
            : "Check the AI values in .env. The dashboard server log identifies the invalid setting."}
        </p>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const failed = ["failed", "unavailable", "denied", "not_found"].includes(message.outcome ?? "");
  const uncertain = message.outcome === "uncertain";
  return (
    <li className={`${styles.bubbleRow} ${isUser ? styles.bubbleUser : styles.bubbleEpi}`}>
      <span className={styles.bubbleAvatar} aria-hidden="true">
        {isUser ? <UserRound size={15} /> : <Bot size={15} />}
      </span>
      <div
        className={`${styles.bubble} ${failed || uncertain ? styles.bubbleFailed : ""} ${message.changed ? styles.bubbleChanged : ""}`}
      >
        <p>{message.text}</p>
        {message.changed ? (
          <span className={styles.bubbleTag}>
            <CircleCheck size={12} aria-hidden="true" /> Saved
          </span>
        ) : null}
        {failed && !message.changed ? (
          <span className={`${styles.bubbleTag} ${styles.bubbleTagWarn}`}>
            <CircleAlert size={12} aria-hidden="true" /> Nothing was changed
          </span>
        ) : null}
        {uncertain ? (
          <span className={`${styles.bubbleTag} ${styles.bubbleTagWarn}`}>
            <CircleAlert size={12} aria-hidden="true" /> Check saved items before retrying
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function AssistantChat({
  setup,
  messages,
  asking,
  budgetNote,
  timezone,
  voice,
  onSend,
}: {
  setup: AssistantSetup;
  messages: ChatMessage[];
  asking: boolean;
  budgetNote: string | null;
  timezone: string;
  voice: { listen: boolean; speak: boolean };
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ready = setup === "ready";
  const last = messages.at(-1);
  const awaitingConfirmation =
    !asking && last?.role === "epi" && last.outcome === "confirmation_needed";

  const lastEpi = messages.findLast((message) => message.role === "epi");
  const speech = useSpokenReplies(voice.speak, lastEpi?.text ?? null, lastEpi?.id ?? 0);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, asking]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || asking || !ready || trimmed.length > MAX_LENGTH) return;
    speech.stop();
    setVoiceNotice(null);
    onSend(trimmed);
    setDraft("");
    inputRef.current?.focus();
  }

  const tooLong = draft.trim().length > MAX_LENGTH;

  function submit(event: FormEvent) {
    event.preventDefault();
    send(draft);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(draft);
    }
  }

  return (
    <section className={styles.chat} aria-label="Ask Epi">
      {ready ? null : <SetupHelp setup={setup} />}
      {budgetNote ? (
        <p className={styles.chatBudget} role="status">
          <CircleAlert size={14} aria-hidden="true" /> {budgetNote}
        </p>
      ) : null}
      {messages.length === 0 ? (
        <div className={styles.chatEmpty}>
          <div className={styles.terminalLabel}>
            <span>COMMUNICATIONS / EPI</span>
            <span>TEXT INTERFACE</span>
          </div>
          <span className={styles.chatEmptyIcon} aria-hidden="true">
            <Sparkles size={26} />
          </span>
          <h2>Just tell me what&apos;s on your mind</h2>
          <p>
            Write it the way you&apos;d say it. Epi uses your timezone ({timezone}) and tells you
            exactly what was saved.
          </p>
          {ready ? (
            <ul className={styles.suggestions} aria-label="Examples">
              {SUGGESTIONS.map(({ text, icon: Icon }) => (
                <li key={text}>
                  <button type="button" onClick={() => send(text)} disabled={asking}>
                    <Icon size={17} aria-hidden="true" />
                    <span>{text}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <ol className={styles.thread} role="log" aria-live="polite" aria-label="Conversation">
          {messages.map((message) => (
            <Bubble key={message.id} message={message} />
          ))}
          {asking ? (
            <li className={`${styles.bubbleRow} ${styles.bubbleEpi}`} aria-label="Epi is thinking">
              <span className={styles.bubbleAvatar} aria-hidden="true">
                <Bot size={15} />
              </span>
              <div className={`${styles.bubble} ${styles.typing}`}>
                <span />
                <span />
                <span />
              </div>
            </li>
          ) : null}
        </ol>
      )}
      <div ref={endRef} />
      {awaitingConfirmation ? (
        <div className={styles.quickReplies} role="group" aria-label="Confirm">
          <button type="button" className={styles.dangerButton} onClick={() => send("yes")}>
            Yes, confirm
          </button>
          <button type="button" className={styles.secondaryButton} onClick={() => send("no")}>
            No, cancel
          </button>
        </div>
      ) : null}
      <form className={styles.chatComposer} onSubmit={submit}>
        <label className={styles.srOnly} htmlFor="epi-message">
          Message Epi
        </label>
        <textarea
          id="epi-message"
          ref={inputRef}
          value={draft}
          rows={2}
          disabled={!ready}
          placeholder={
            ready ? "Write anything: a task, a note, or a question" : "Epi is not set up yet"
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={keyDown}
        />
        {voice.listen ? (
          <PushToTalk
            disabled={!ready || asking}
            onStart={speech.stop}
            onHeard={(text) => send(text)}
            onNotice={(text, heard) => {
              setVoiceNotice(text);
              if (heard) setDraft(heard);
            }}
          />
        ) : null}
        <button
          type="submit"
          className={styles.sendButton}
          disabled={!ready || asking || !draft.trim() || tooLong}
          aria-label="Send message"
        >
          <SendHorizontal size={18} aria-hidden="true" />
        </button>
        {voiceNotice ? (
          <p className={`${styles.chatHint} ${styles.chatHintWarn}`} role="status">
            {voiceNotice}
          </p>
        ) : null}
        {speech.speaking ? <StopSpeaking onStop={speech.stop} /> : null}
        {tooLong ? (
          <p className={`${styles.chatHint} ${styles.chatHintWarn}`} role="alert">
            That&apos;s {draft.trim().length - MAX_LENGTH} characters too long. Epi reads up to{" "}
            {MAX_LENGTH} at a time, so please send it in smaller pieces.
          </p>
        ) : (
          <p className={styles.chatHint}>Enter to send, Shift+Enter for a new line.</p>
        )}
      </form>
    </section>
  );
}
