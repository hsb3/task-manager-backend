// Unit tests for the account flow module's pure functions.
import { describe, expect, test } from "bun:test";
import { ClientResponseError } from "pocketbase";
import {
  errorResult,
  expiresFromDate,
  formatDate,
  keyStatus,
  pendingStatus,
  reachLabel,
  safeRedirect,
  validateEmail,
  validateKeyName,
  validateName,
  validatePassword,
  validatePasswordConfirm,
  type Workspace,
} from "./account";

const now = new Date("2026-11-11T10:00:00Z");

describe("keyStatus", () => {
  test("revoked wins over a future expiry", () => {
    expect(
      keyStatus({ revoked: true, expires: "2099-01-01 00:00:00.000Z" }, now),
    ).toBe("Revoked");
  });
  test("a past expiry is Expired", () => {
    expect(
      keyStatus({ revoked: false, expires: "2020-01-01 00:00:00.000Z" }, now),
    ).toBe("Expired");
  });
  test("an expiry equal to now is Expired", () => {
    expect(
      keyStatus({ revoked: false, expires: "2026-11-11 10:00:00.000Z" }, now),
    ).toBe("Expired");
  });
  test("a future expiry is Active", () => {
    expect(
      keyStatus({ revoked: false, expires: "2099-01-01 00:00:00.000Z" }, now),
    ).toBe("Active");
  });
  test("no expiry is Active", () => {
    expect(keyStatus({ revoked: false, expires: "" }, now)).toBe("Active");
  });
});

describe("formatDate", () => {
  test("a stored date shows to the minute in UTC", () => {
    expect(formatDate("2026-11-10 22:13:28.369Z")).toBe("2026-11-10 22:13 UTC");
  });
  test("an empty date is Never", () => {
    expect(formatDate("")).toBe("Never");
  });
});

describe("expiresFromDate", () => {
  const refused = {
    ok: false as const,
    message: "Choose a date after today.",
    fields: { expires: "Choose a date after today." },
    status: 0,
  };
  test("no date is no expiry", () => {
    expect(expiresFromDate("", now)).toEqual({ ok: true, value: null });
  });
  test("tomorrow is UTC midnight that day", () => {
    expect(expiresFromDate("2026-11-12", now)).toEqual({
      ok: true,
      value: "2026-11-12 00:00:00.000Z",
    });
  });
  test("today is refused", () => {
    expect(expiresFromDate("2026-11-11", now)).toEqual(refused);
  });
  test("a date that does not exist is refused", () => {
    expect(expiresFromDate("2026-02-30", now)).toEqual(refused);
  });
  test("another format is refused", () => {
    expect(expiresFromDate("12/01/2026", now)).toEqual(refused);
  });
});

describe("safeRedirect", () => {
  test("a screen path passes", () => {
    expect(safeRedirect("/keys")).toBe("/keys");
  });
  test("a protocol-relative URL is ignored", () => {
    expect(safeRedirect("//evil.example")).toBeUndefined();
  });
  test("an absolute URL is ignored", () => {
    expect(safeRedirect("https://evil.example")).toBeUndefined();
  });
  test("no value is ignored", () => {
    expect(safeRedirect(undefined)).toBeUndefined();
  });
});

describe("validators", () => {
  test("email", () => {
    expect(validateEmail("")).toBe("Enter an email address.");
    expect(validateEmail("  ")).toBe("Enter an email address.");
    expect(validateEmail("nope")).toBe("Enter an email address.");
    expect(validateEmail("a@b")).toBeUndefined();
  });
  test("name", () => {
    expect(validateName("   ")).toBe("Cannot be blank.");
    expect(validateName("x".repeat(256))).toBe("Use at most 255 characters.");
  });
  test("password", () => {
    expect(validatePassword("1234567")).toBe("Use at least 8 characters.");
    expect(validatePasswordConfirm("abcdefgh", "abcdefgi")).toBe(
      "The passwords do not match.",
    );
  });
  test("key name", () => {
    expect(validateKeyName("")).toBe("Use 1 to 200 characters.");
    expect(validateKeyName("x".repeat(201))).toBe("Use 1 to 200 characters.");
    expect(validateKeyName(" k ")).toBeUndefined();
  });
});

describe("reachLabel", () => {
  const workspaces: Workspace[] = [
    { id: "ws1", name: "Home", role: "owner", status: "active" },
  ];
  const item = (
    reach: "all" | "workspace" | "projects",
    workspace = "",
    projects: string[] = [],
  ) => ({ reach, workspace, projects });
  test("all", () => {
    expect(reachLabel(item("all"), workspaces)).toBe("All workspaces");
  });
  test("a known workspace shows its name", () => {
    expect(reachLabel(item("workspace", "ws1"), workspaces)).toBe("Home");
  });
  test("an unknown workspace shows its id", () => {
    expect(reachLabel(item("workspace", "ws9"), workspaces)).toBe("ws9");
  });
  test("projects are counted", () => {
    expect(reachLabel(item("projects", "ws1", ["p1", "p2"]), workspaces)).toBe(
      "2 projects in Home",
    );
  });
  test("one project is singular", () => {
    expect(reachLabel(item("projects", "ws1", ["p1"]), workspaces)).toBe(
      "1 project in Home",
    );
  });
  test("projects in an unknown workspace show its id", () => {
    expect(reachLabel(item("projects", "ws9", ["p1"]), workspaces)).toBe(
      "1 project in ws9",
    );
  });
});

describe("pendingStatus", () => {
  test("verified, not approved", () => {
    expect(pendingStatus({ verified: true, approved: false })).toBe(
      "Waiting for approval",
    );
  });
  test("neither", () => {
    expect(pendingStatus({ verified: false, approved: false })).toBe(
      "Email not confirmed; waiting for approval",
    );
  });
  test("approved, not verified", () => {
    expect(pendingStatus({ verified: false, approved: true })).toBe(
      "Waiting for email confirmation",
    );
  });
});

describe("errorResult", () => {
  test("429 is the rate-limit message", () => {
    const r = errorResult(
      new ClientResponseError({
        status: 429,
        response: { message: "x", data: {} },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.message).toBe("Too many attempts. Wait a minute and try again.");
  });
  test("no answer is unreachable", () => {
    const r = errorResult(new ClientResponseError({ status: 0, response: {} }));
    if (!r.ok)
      expect(r.message).toBe("The server could not be reached. Try again.");
    expect(r.ok).toBe(false);
  });
  test("field data maps to field messages", () => {
    const r = errorResult(
      new ClientResponseError({
        status: 400,
        response: {
          message: "m",
          data: {
            name: { code: "validation_required", message: "Cannot be blank." },
          },
        },
      }),
    );
    expect(r).toEqual({
      ok: false,
      message: "m",
      fields: { name: "Cannot be blank." },
      status: 400,
    });
  });
  test("no field data gives no fields", () => {
    const r = errorResult(
      new ClientResponseError({ status: 400, response: { message: "m" } }),
    );
    expect(r).toEqual({ ok: false, message: "m", fields: {}, status: 400 });
  });
  test("a non-SDK error is unreachable", () => {
    expect(errorResult(new Error("x"))).toEqual({
      ok: false,
      message: "The server could not be reached. Try again.",
      fields: {},
      status: 0,
    });
  });
});
