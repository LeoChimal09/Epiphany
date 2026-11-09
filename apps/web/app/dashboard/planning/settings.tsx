"use client";

import { useId, useState, type ReactNode } from "react";
import {
  Brain,
  CalendarClock,
  Coffee,
  Moon,
  Shield,
  SlidersHorizontal,
  Timer,
  Footprints,
  BellRing,
  Sun,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import type {
  PlanningPreferences,
  PlanningSettingKey,
  TimeWindow,
  Weekday,
} from "@epiphany/core/planning";
import {
  saveLearningAllowance,
  saveLearningSetting,
  savePlanningSetting,
  saveGreetingSetting,
  saveVoiceSettings,
  type VoiceChoices,
} from "./actions";
import { clockSummary, DefaultEditor } from "./default-editor";
import styles from "./settings.module.css";

const DAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function WindowFields({
  value,
  onChange,
}: {
  value: TimeWindow;
  onChange: (value: TimeWindow) => void;
}) {
  return (
    <span className={styles.window}>
      <label>
        Start (AM/PM){" "}
        <input
          type="time"
          aria-label="Start time"
          value={value.start}
          onChange={(e) => onChange({ ...value, start: e.target.value })}
          required
        />
      </label>
      <label>
        End (AM/PM){" "}
        <input
          type="time"
          aria-label="End time"
          value={value.end === "24:00" ? "00:00" : value.end}
          onChange={(e) =>
            onChange({
              ...value,
              end: value.end === "24:00" && e.target.value === "00:00" ? "24:00" : e.target.value,
            })
          }
          required
        />
      </label>
    </span>
  );
}

function Section<T>({
  title,
  icon,
  summary,
  onReset,
  setting,
  value,
  version,
  pausedVersion,
  children,
}: {
  title: string;
  icon: LucideIcon;
  summary: (saved: T) => string;
  onReset: (saved: T) => void;
  setting: PlanningSettingKey | "tracking.enabled" | "tracking.check_ins";
  value: T;
  version?: number;
  pausedVersion?: number;
  children: ReactNode;
}) {
  const [savedVersion, setSavedVersion] = useState(version);
  const [savedPausedVersion, setSavedPausedVersion] = useState(pausedVersion);
  return (
    <DefaultEditor
      title={title}
      icon={icon}
      value={value}
      summary={summary}
      onReset={onReset}
      onSave={async (draft) => {
        const result =
          setting === "tracking.enabled"
            ? await saveLearningAllowance(
                draft === true,
                savedVersion,
                savedPausedVersion,
                draft === true,
              )
            : setting === "tracking.check_ins"
              ? await saveLearningSetting(setting, draft === true, savedVersion, draft === true)
              : await savePlanningSetting(setting, draft, savedVersion);
        if (result.ok) {
          setSavedVersion(result.version);
          if ("pausedVersion" in result && typeof result.pausedVersion === "number")
            setSavedPausedVersion(result.pausedVersion);
        }
        return result;
      }}
    >
      {children}
    </DefaultEditor>
  );
}

function voiceSummary(saved: VoiceChoices): string {
  const parts = [
    saved.replies && "replies",
    saved.wellBeing && "well-being questions",
    saved.reminders && "reminders",
    saved.briefing && "briefing",
  ].filter(Boolean);
  return parts.length ? `Spoken · ${parts.join(", ")}` : "Text only";
}

function VoiceSettings({
  value,
  versions,
}: {
  value: VoiceChoices;
  versions: { replies?: number; checkIns?: number };
}) {
  const [choices, setChoices] = useState(value);
  const [saved, setSaved] = useState(versions);
  const box = (key: keyof VoiceChoices, label: string) => (
    <label>
      <input
        type="checkbox"
        checked={choices[key]}
        onChange={(event) => setChoices({ ...choices, [key]: event.target.checked })}
      />{" "}
      {label}
    </label>
  );
  return (
    <DefaultEditor
      title="Spoken messages"
      icon={Volume2}
      value={choices}
      summary={voiceSummary}
      onReset={setChoices}
      onSave={async (draft) => {
        const result = await saveVoiceSettings(draft, saved);
        if (result.ok) setSaved(result.versions);
        return result;
      }}
    >
      <p>Text is always sent first; ticked messages also get an audio clip in Discord.</p>
      {box("replies", "Replies when I talk to Epi")}
      {box("wellBeing", "Well-being questions")}
      {box("reminders", "Reminders and check-ins")}
      {box("briefing", "Morning briefing")}
      <p>
        Uses the voice budget. When it runs out, or voice is not set up, messages stay text only.
      </p>
    </DefaultEditor>
  );
}

export function GreetingSettings({
  value,
  version,
}: {
  value: { enabled: boolean; address: string | null };
  version?: number;
}) {
  const [enabled, setEnabled] = useState(value.enabled);
  const [address, setAddress] = useState(value.address ?? "");
  const [savedVersion, setSavedVersion] = useState(version);
  return (
    <DefaultEditor
      title="Morning greeting"
      icon={Sun}
      value={{ enabled, address: address.trim() || null }}
      summary={(saved) =>
        saved.enabled
          ? `On${saved.address ? ` · calls you "${saved.address}"` : ""}`
          : "Off · briefing only"
      }
      onReset={(saved) => {
        setEnabled(saved.enabled);
        setAddress(saved.address ?? "");
      }}
      onSave={async (draft) => {
        const result = await saveGreetingSetting(draft, savedVersion);
        if (result.ok) setSavedVersion(result.version);
        return result;
      }}
    >
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />{" "}
        Open the briefing with a personal &quot;how are we doing&quot; greeting
      </label>
      <label>
        Call me{" "}
        <input
          value={address}
          maxLength={40}
          placeholder="sir"
          onChange={(event) => setAddress(event.target.value)}
        />
      </label>
      <p>
        Epi writes it from your day and what it remembers about you; without AI it uses a simple
        greeting. With learning allowed, your reply can teach Epi about you, and anything lasting is
        kept only after you approve it.
      </p>
    </DefaultEditor>
  );
}

export function PlanningSettings({
  preferences,
  versions,
  learning = { enabled: false, paused: false, insights: [] },
  notifications,
  voice = { replies: false, wellBeing: false, reminders: false, briefing: false },
}: {
  preferences: PlanningPreferences;
  versions: Record<string, number>;
  learning?: { enabled: boolean; paused: boolean; insights: string[]; checkIns?: boolean };
  notifications?: ReactNode;
  voice?: VoiceChoices;
}) {
  const [tab, setTab] = useState("routine");
  const tabsId = useId();
  const [learn, setLearn] = useState(learning.enabled && !learning.paused);
  const [checkIns, setCheckIns] = useState(learning.checkIns ?? false);
  const [hours, setHours] = useState(preferences.preferredHours);
  const [limitHours, setLimitHours] = useState(
    !DAYS.every(
      (day) =>
        preferences.preferredHours[day]?.length === 1 &&
        preferences.preferredHours[day]?.[0]?.start === "00:00" &&
        preferences.preferredHours[day]?.[0]?.end === "24:00",
    ),
  );
  const [sleep, setSleep] = useState(preferences.sleep ?? null);
  const [meals, setMeals] = useState(preferences.meals ?? []);
  const [protectedTime, setProtectedTime] = useState(
    (preferences.protectedTime ?? []).filter((item) => "window" in item),
  );
  const [buffer, setBuffer] = useState(preferences.bufferMinutes);
  const [minimum, setMinimum] = useState(preferences.minBlockMinutes);
  const [travelBefore, setTravelBefore] = useState(preferences.travelBeforeMinutes ?? 0);
  const [travelAfter, setTravelAfter] = useState(preferences.travelAfterMinutes ?? 0);
  return (
    <div className={styles.defaults}>
      <nav className={styles.tabs} aria-label="Planning default groups">
        {(
          [
            ["routine", "Routine", CalendarClock],
            ["notifications", "Notifications", BellRing],
            ["learning", "Learning", Brain],
            ["voice", "Voice", Volume2],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            aria-controls={`${tabsId}-${key}`}
            onClick={() => setTab(key)}
          >
            <Icon size={16} aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>
      <section
        hidden={tab !== "notifications"}
        id={`${tabsId}-notifications`}
        aria-label="Notification defaults"
      >
        {notifications}
      </section>
      <section hidden={tab !== "voice"} id={`${tabsId}-voice`} aria-label="Voice defaults">
        <VoiceSettings
          value={voice}
          versions={{ replies: versions["voice.replies"], checkIns: versions["voice.check_ins"] }}
        />
      </section>
      <section hidden={tab !== "learning"} id={`${tabsId}-learning`} aria-label="Learning defaults">
        <Section
          title="Personal learning"
          icon={Brain}
          summary={(saved) => (saved ? "Allowed · reported durations and snoozes" : "Not allowed")}
          onReset={setLearn}
          setting="tracking.enabled"
          value={learn}
          version={versions["tracking.enabled"]}
          pausedVersion={versions["tracking.paused"]}
        >
          <label>
            <input
              type="checkbox"
              checked={learn}
              onChange={(event) => setLearn(event.target.checked)}
            />{" "}
            Allow Epi to learn from what I tell it
          </label>
          <p>
            Uses reported durations and snoozes for estimates, with occasional optional questions.
            Preferences need your approval. No AI retraining or monitoring.
          </p>
          <p>
            Save to give permission. Turning this off stops collection and use; ask Epi to forget
            reports to erase them.
          </p>
          {learning.insights.length ? (
            <ul>
              {learning.insights.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : (
            <p>Estimates need at least three similar reports.</p>
          )}
        </Section>
        <Section
          title="Discord check-ins"
          icon={BellRing}
          summary={(saved) =>
            saved ? "Allowed · occasional private questions" : "Off · conversation only"
          }
          onReset={setCheckIns}
          setting="tracking.check_ins"
          value={checkIns}
          version={versions["tracking.check_ins"]}
        >
          <label>
            <input
              type="checkbox"
              checked={checkIns}
              onChange={(event) => setCheckIns(event.target.checked)}
            />{" "}
            Allow Epi to message me first
          </label>
          <p>
            With learning allowed, Epi may ask a new question in your private Discord check-ins
            channel, no more than once every three days.
          </p>
          <p>
            Only when your routine and calendar show at least 30 free minutes, outside quiet hours
            and pauses. This is not online-status monitoring. No repeated topics or follow-up
            nagging.
          </p>
          <p>
            Answers can guide tone, reply length, and planning advice after you approve remembering
            them. No answer is required.
          </p>
        </Section>
      </section>
      <section hidden={tab !== "routine"} id={`${tabsId}-routine`} aria-label="Routine defaults">
        <p className={styles.groupNote}>
          Usual availability, not calendar events. Individual plans can differ.
        </p>
        <Section
          title="Planning hours"
          icon={CalendarClock}
          summary={(saved) =>
            saved === null ? "Use free time around your routine" : "Custom weekly limits"
          }
          onReset={(saved) => {
            setLimitHours(saved !== null);
            if (saved) setHours(saved);
          }}
          setting="planning.preferred_hours"
          value={limitHours ? hours : null}
          version={versions["planning.preferred_hours"]}
        >
          <p>Optional limits for suggested tasks. Leave off to use your routine and calendar.</p>
          <label>
            <input
              type="checkbox"
              checked={limitHours}
              onChange={(e) => setLimitHours(e.target.checked)}
            />{" "}
            Limit planning to specific hours
          </label>
          {limitHours ? (
            <p>Leave a day empty to mark it unavailable. Split overnight hours across two days.</p>
          ) : null}
          {limitHours
            ? DAYS.map((day) => (
                <div key={day}>
                  <h3>{day.toUpperCase()}</h3>
                  {(hours[day] ?? []).map((window, index) => (
                    <div className={styles.row} key={index}>
                      <WindowFields
                        value={window}
                        onChange={(value) =>
                          setHours({
                            ...hours,
                            [day]: hours[day]!.map((w, i) => (i === index ? value : w)),
                          })
                        }
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setHours({ ...hours, [day]: hours[day]!.filter((_, i) => i !== index) })
                        }
                      >
                        Remove window
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={(hours[day]?.length ?? 0) >= 8}
                    onClick={() =>
                      setHours({
                        ...hours,
                        [day]: [...(hours[day] ?? []), { start: "09:00", end: "17:00" }],
                      })
                    }
                  >
                    Add {day} window
                  </button>
                </div>
              ))
            : null}
        </Section>
        <Section
          title="Sleep"
          icon={Moon}
          summary={(saved) =>
            saved
              ? `${clockSummary(saved.start)} – ${clockSummary(saved.end)} · daily`
              : "Not protected"
          }
          onReset={setSleep}
          setting="planning.sleep"
          value={sleep}
          version={versions["planning.sleep"]}
        >
          <label>
            <input
              type="checkbox"
              checked={sleep !== null}
              onChange={(e) => setSleep(e.target.checked ? { start: "23:00", end: "07:00" } : null)}
            />{" "}
            Protect sleep every day
          </label>
          {sleep ? <WindowFields value={sleep} onChange={setSleep} /> : null}
        </Section>
        <Section
          title="Meals"
          icon={Coffee}
          summary={(saved) =>
            saved.length
              ? saved
                  .map((meal) => `${clockSummary(meal.start)} – ${clockSummary(meal.end)}`)
                  .join(" · ")
              : "No meal breaks"
          }
          onReset={setMeals}
          setting="planning.meals"
          value={meals}
          version={versions["planning.meals"]}
        >
          <p>Daily meal breaks.</p>
          {meals.map((meal, index) => (
            <div className={styles.row} key={index}>
              <WindowFields
                value={meal}
                onChange={(value) => setMeals(meals.map((w, i) => (i === index ? value : w)))}
              />
              <button type="button" onClick={() => setMeals(meals.filter((_, i) => i !== index))}>
                Remove meal
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={meals.length >= 8}
            onClick={() => setMeals([...meals, { start: "12:00", end: "13:00" }])}
          >
            Add meal
          </button>
        </Section>
        <Section
          title="Protected time"
          icon={Shield}
          summary={(saved) =>
            saved.length
              ? `${saved.length} personal time ${saved.length === 1 ? "block" : "blocks"}`
              : "No extra blocks"
          }
          onReset={setProtectedTime}
          setting="planning.protected_time"
          value={protectedTime}
          version={versions["planning.protected_time"]}
        >
          <p>Block out personal time on selected days.</p>
          {protectedTime.map((item, index) => (
            <fieldset key={index} className={styles.protected}>
              <label>
                Label{" "}
                <input
                  value={item.label}
                  maxLength={100}
                  required
                  onChange={(e) =>
                    setProtectedTime(
                      protectedTime.map((p, i) =>
                        i === index ? { ...p, label: e.target.value } : p,
                      ),
                    )
                  }
                />
              </label>
              <WindowFields
                value={item.window}
                onChange={(window) =>
                  setProtectedTime(
                    protectedTime.map((p, i) => (i === index ? { ...p, window } : p)),
                  )
                }
              />
              <div className={styles.row}>
                {DAYS.map((day) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={item.weekdays?.includes(day) ?? true}
                      onChange={(e) =>
                        setProtectedTime(
                          protectedTime.map((p, i) =>
                            i === index
                              ? {
                                  ...p,
                                  weekdays: e.target.checked
                                    ? [...(p.weekdays ?? DAYS), day]
                                    : (p.weekdays ?? DAYS).filter((d) => d !== day),
                                }
                              : p,
                          ),
                        )
                      }
                    />
                    {day}
                  </label>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setProtectedTime(protectedTime.filter((_, i) => i !== index))}
              >
                Remove protected time
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            disabled={protectedTime.length >= 30}
            onClick={() =>
              setProtectedTime([
                ...protectedTime,
                { label: "", weekdays: [...DAYS], window: { start: "17:00", end: "18:00" } },
              ])
            }
          >
            Add protected time
          </button>
        </Section>
        <h2 className={styles.groupHeading}>
          Scheduling details <span>Optional defaults</span>
        </h2>
        <Section
          title="Event buffer"
          icon={SlidersHorizontal}
          summary={(saved) => `${saved} min before and after events`}
          onReset={setBuffer}
          setting="planning.buffer_minutes"
          value={buffer}
          version={versions["planning.buffer_minutes"]}
        >
          <label>
            Minutes before and after timed events{" "}
            <input
              type="number"
              min={0}
              max={120}
              required
              value={buffer}
              onChange={(e) => setBuffer(e.target.valueAsNumber)}
            />
          </label>
        </Section>
        <Section
          title="Travel before events"
          icon={Footprints}
          summary={(saved) => (saved ? `${saved} min before every event` : "None")}
          onReset={setTravelBefore}
          setting="planning.travel_before_minutes"
          value={travelBefore}
          version={versions["planning.travel_before_minutes"]}
        >
          <p>
            Applies to every timed event, including online events. Leave at zero if travel varies.
          </p>
          <label>
            Minutes before each timed event{" "}
            <input
              type="number"
              min={0}
              max={240}
              required
              value={travelBefore}
              onChange={(e) => setTravelBefore(e.target.valueAsNumber)}
            />
          </label>
        </Section>
        <Section
          title="Travel after events"
          icon={Footprints}
          summary={(saved) => (saved ? `${saved} min after every event` : "None")}
          onReset={setTravelAfter}
          setting="planning.travel_after_minutes"
          value={travelAfter}
          version={versions["planning.travel_after_minutes"]}
        >
          <label>
            Minutes after each timed event{" "}
            <input
              type="number"
              min={0}
              max={240}
              required
              value={travelAfter}
              onChange={(e) => setTravelAfter(e.target.valueAsNumber)}
            />
          </label>
        </Section>
        <Section
          title="Minimum work block"
          icon={Timer}
          summary={(saved) => `${saved} min`}
          onReset={setMinimum}
          setting="planning.min_block_minutes"
          value={minimum}
          version={versions["planning.min_block_minutes"]}
        >
          <label>
            Minimum usable minutes{" "}
            <input
              type="number"
              min={10}
              max={240}
              required
              value={minimum}
              onChange={(e) => setMinimum(e.target.valueAsNumber)}
            />
          </label>
        </Section>
      </section>
    </div>
  );
}
