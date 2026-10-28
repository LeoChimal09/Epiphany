import { describe, expect, it } from "vitest";
import { errorDetails } from "./error-details";

describe("worker error details", () => {
  it("includes useful error context while redacting credentials and query text", () => {
    const error = Object.assign(
      new Error(
        "Access denied for mysql://epi:pw123@db.example/app?token=abc password=topsecret SQL: SELECT * FROM tasks",
      ),
      { code: "ER_ACCESS_DENIED_ERROR" },
    );

    expect(errorDetails(error)).toEqual({
      errorName: "Error",
      errorCode: "ER_ACCESS_DENIED_ERROR",
      errorMessage: "Access denied for [redacted URL] password=[redacted] [query omitted]",
    });
  });

  it("handles non-Error throws without exposing an unbounded value", () => {
    expect(errorDetails("failure")).toEqual({
      errorName: "NonErrorThrown",
    });
  });
});
