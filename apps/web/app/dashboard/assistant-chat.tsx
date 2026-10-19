"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Bot, CircleAlert, CircleCheck, SendHorizontal, Sparkles, UserRound } from "lucide-react";
import type { AssistantReply } from "@epiphany/core/assistant";
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
  "What's on my plate?",
  "What does my week look like?",
  "Add a task: read chapter 4 by Friday",
  "Idea: an app that tracks workouts against free time",
];
const MAX_LENGTH = 2000;

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
  return (
    <li className={`${styles.bubbleRow} ${isUser ? styles.bubbleUser : styles.bubbleEpi}`}>
      <span className={styles.bubbleAvatar} aria-hidden="true">
        {isUser ? <UserRound size={15} /> : <Bot size={15} />}
      </span>
      <div
        className={`${styles.bubble} ${failed ? styles.bubbleFailed : ""} ${message.changed ? styles.bubbleChanged : ""}`}
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
  onSend,
}: {
  setup: AssistantSetup;
  messages: ChatMessage[];
  asking: boolean;
  budgetNote: string | null;
  timezone: string;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ready = setup === "ready";
  const last = messages.at(-1);
  const awaitingConfirmation =
    !asking && last?.role === "epi" && last.outcome === "confirmation_needed";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, asking]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || asking || !ready) return;
    onSend(trimmed);
    setDraft("");
    inputRef.current?.focus();
  }

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
              {SUGGESTIONS.map((text) => (
                <li key={text}>
                  <button type="button" onClick={() => send(text)} disabled={asking}>
                    {text}
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
            Yes, do it
          </button>
          <button type="button" className={styles.secondaryButton} onClick={() => send("no")}>
            No, keep it
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
          maxLength={MAX_LENGTH}
          disabled={!ready}
          placeholder={
            ready ? "Write anything: a task, a note, or a question" : "Epi is not set up yet"
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={keyDown}
        />
        <button
          type="submit"
          className={styles.sendButton}
          disabled={!ready || asking || !draft.trim()}
          aria-label="Send message"
        >
          <SendHorizontal size={18} aria-hidden="true" />
        </button>
        <p className={styles.chatHint}>Enter to send, Shift+Enter for a new line.</p>
      </form>
    </section>
  );
}
