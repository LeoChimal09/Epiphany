"use client";

import { useState, type ReactNode } from "react";
import { BriefcaseBusiness, Clock3, Moon, SlidersHorizontal } from "lucide-react";
import type {
  PlanningPreferences,
  PlanningSettingKey,
  TimeWindow,
  Weekday,
} from "@epiphany/core/planning";
import { savePlanningSetting } from "./actions";
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

function Section({
  title,
  setting,
  value,
  version,
  children,
}: {
  title: string;
  setting: PlanningSettingKey;
  value: unknown;
  version?: number;
  children: ReactNode;
}) {
  const [savedVersion, setSavedVersion] = useState(version);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <details
      className={styles.section}
      data-tone={setting === "planning.preferred_hours" ? "work" : undefined}
    >
      <summary>
        {setting === "planning.preferred_hours" ? (
          <BriefcaseBusiness size={22} aria-hidden="true" />
        ) : (
          <Clock3 size={20} aria-hidden="true" />
        )}
        <span className={styles.summaryText}>
          <strong>{title}</strong>
          {setting === "planning.preferred_hours" ? (
            <small>When Epi can plan tasks for you</small>
          ) : null}
        </span>
      </summary>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          setMessage("");
          try {
            const result = await savePlanningSetting(setting, value, savedVersion);
            setFailed(!result.ok);
            setMessage(result.ok ? "Saved." : result.error);
            if (result.ok) setSavedVersion(result.version);
          } catch {
            setFailed(true);
            setMessage("Could not confirm the save. Reload to check before trying again.");
          } finally {
            setPending(false);
          }
        }}
      >
        <fieldset disabled={pending} className={styles.fields}>
          {children}
          <button type="submit">{pending ? "Saving..." : `Save ${title.toLowerCase()}`}</button>
        </fieldset>
        {message ? <p role={failed ? "alert" : "status"}>{message}</p> : null}
      </form>
    </details>
  );
}

export function PlanningSettings({
  preferences,
  versions,
}: {
  preferences: PlanningPreferences;
  versions: Record<string, number>;
}) {
  const [hours, setHours] = useState(preferences.preferredHours);
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
    <div>
      <Section
        title="Work hours"
        setting="planning.preferred_hours"
        value={hours}
        version={versions["planning.preferred_hours"]}
      >
        <p>
          Epi plans work during these hours. Leave a day empty to mark it unavailable. Split
          overnight hours across two days.
        </p>
        {DAYS.map((day) => (
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
        ))}
      </Section>
      <details className={styles.group} data-tone="routine">
        <summary>
          <Moon size={22} aria-hidden="true" />
          <span className={styles.summaryText}>
            <strong>Daily routine</strong>
            <small>Sleep, meals, and protected personal time</small>
          </span>
        </summary>
        <Section
          title="Sleep"
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
      </details>
      <details className={styles.group} data-tone="advanced">
        <summary>
          <SlidersHorizontal size={22} aria-hidden="true" />
          <span className={styles.summaryText}>
            <strong>More planning options</strong>
            <small>Event buffers, travel, and minimum work blocks</small>
          </span>
        </summary>
        <Section
          title="Event buffer"
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
          setting="planning.travel_before_minutes"
          value={travelBefore}
          version={versions["planning.travel_before_minutes"]}
        >
          <p>
            Optional default for every timed event, including online events. Leave at zero and use
            specific protected time if only some events require travel. Buffers are added outside
            travel time.
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
      </details>
    </div>
  );
}
