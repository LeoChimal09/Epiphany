"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  Bot,
  ArrowUpRight,
  CalendarDays,
  CircleAlert,
  CircleCheck,
  Lightbulb,
  ListChecks,
  Plus,
  RotateCw,
  SendHorizontal,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import type { ChatMessage, ChatSessionSummary } from "@epiphany/core/assistant";
import { PushToTalk, StopSpeaking, useSpokenReplies } from "./voice-controls";
import styles from "./workspace.module.css";

export type { ChatMessage } from "@epiphany/core/assistant";

export type AssistantSetup = "ready" | "needs_key" | "misconfigured";

const SUGGESTIONS = [
  { text: "What's on my plate?", icon: ListChecks },
  { text: "What does my week look like?", icon: CalendarDays },
  { text: "Add a task: read chapter 4 by Friday", icon: Plus },
  { text: "Idea: an app that tracks workouts against free time", icon: Lightbulb },
];
const MAX_LENGTH = 8000;

function shortDate(iso: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(
      new Date(iso),
    );
  } catch {
    return iso.slice(0, 10);
  }
}

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

function Bubble({
  message,
  onOpenItem,
}: {
  message: ChatMessage;
  onOpenItem: (href: string) => void;
}) {
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
        {!isUser && message.links?.length ? (
          <div className={styles.savedItemLinks}>
            {message.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={(event) => {
                  event.preventDefault();
                  onOpenItem(link.href);
                }}
              >
                {link.label} <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            ))}
          </div>
        ) : null}
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
  topic,
  onClearTopic,
  onSend,
  onOpenItem,
  sessions = [],
  sessionId,
  sessionLoading = false,
  sessionBusy = false,
  onNewSession,
  onSwitchSession,
  onReloadSession,
  onDeleteSession,
}: {
  setup: AssistantSetup;
  messages: ChatMessage[];
  asking: boolean;
  budgetNote: string | null;
  timezone: string;
  voice: { listen: boolean; speak: boolean };
  topic?: { label: string; title: string } | null;
  onClearTopic?: () => void;
  onSend: (text: string) => void;
  onOpenItem: (href: string) => void;
  sessions?: ChatSessionSummary[];
  sessionId?: string | null;
  sessionLoading?: boolean;
  sessionBusy?: boolean;
  onNewSession?: () => void;
  onSwitchSession?: (id: string) => void;
  onReloadSession?: () => void;
  onDeleteSession?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ready = setup === "ready" && !sessionLoading && !sessionBusy;
  const last = messages.at(-1);
  const awaitingConfirmation =
    !asking && last?.role === "epi" && last.outcome === "confirmation_needed";

  const lastEpi = messages.findLast((message) => message.role === "epi");
  const [restoredReplyId] = useState(lastEpi?.id ?? 0);
  const speech = useSpokenReplies(
    voice.speak && (lastEpi?.id ?? 0) > restoredReplyId,
    lastEpi?.text ?? null,
    lastEpi?.id ?? 0,
  );

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
      {onNewSession ? (
        <div className={styles.chatSessions}>
          <select
            aria-label="Conversation"
            value={sessionId ?? ""}
            disabled={asking || sessionLoading}
            onChange={(event) => onSwitchSession?.(event.target.value)}
          >
            {!sessionId ? <option value="">Start a conversation</option> : null}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title} · {shortDate(session.updatedAt, timezone)}
              </option>
            ))}
          </select>
          <div className={styles.chatSessionActions}>
            <button
              type="button"
              className={styles.iconButton}
              disabled={asking || sessionLoading}
              onClick={onNewSession}
              aria-label="New conversation"
              title="New conversation"
            >
              <Plus size={16} aria-hidden="true" />
            </button>
            {sessionId ? (
              <>
                <button
                  type="button"
                  className={styles.iconButton}
                  disabled={asking || sessionLoading}
                  onClick={onReloadSession}
                  aria-label="Reload conversation"
                  title="Reload conversation"
                >
                  <RotateCw size={15} aria-hidden="true" />
                </button>
                {onDeleteSession ? (
                  <button
                    type="button"
                    className={`${styles.iconButton} ${styles.iconButtonDanger}`}
                    disabled={asking || sessionLoading || sessionBusy}
                    onClick={onDeleteSession}
                    aria-label="Delete conversation"
                    title="Delete conversation"
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
          <p>Saved privately for 90 days.</p>
        </div>
      ) : null}
      {sessionBusy ? (
        <p role="status">
          A request is in progress. Reload the conversation to retrieve its result; don&apos;t
          resend it.
        </p>
      ) : null}
      {topic ? (
        <div className={styles.chatTopic} role="status">
          <div>
            <span>Talking about {topic.label === "todo" ? "to-do" : topic.label}</span>
            <strong>{topic.title}</strong>
            {topic.label === "note" || topic.label === "idea" ? (
              <p>
                Send additions or a list to update this {topic.label}. Questions won&apos;t change
                it.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={asking}
            onClick={onClearTopic}
          >
            Clear topic
          </button>
        </div>
      ) : null}
      {setup === "ready" ? null : <SetupHelp setup={setup} />}
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
          <h2>
            {topic ? `What would you like to add or change?` : "Just tell me what's on your mind"}
          </h2>
          <p>
            Write it the way you&apos;d say it. Epi uses your timezone ({timezone}) and tells you
            exactly what was saved.
          </p>
          {ready && !topic ? (
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
            <Bubble key={message.id} message={message} onOpenItem={onOpenItem} />
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
            sessionLoading
              ? "Loading conversation..."
              : ready
                ? topic
                  ? `Add to this ${topic.label}, or ask a question`
                  : "Write anything: a task, a note, or a question"
                : "Epi is not set up yet"
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
