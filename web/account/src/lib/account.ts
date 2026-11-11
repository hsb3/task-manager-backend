// The account app's server calls, messages and the shapes it reads; imports only pocketbase.
import PocketBase, {
  type BaseAuthStore,
  ClientResponseError,
} from "pocketbase";

export { BaseAuthStore } from "pocketbase";

export type Scope = "read" | "write" | "manage" | "own";
export type Reach = "all" | "workspace" | "projects";

export interface KeyItem {
  id: string;
  name: string;
  scope: Scope;
  client_id: string;
  manage_keys: boolean;
  created: string;
  expires: string;
  last_used: string;
  revoked: boolean;
  current: boolean;
  reach: Reach;
  workspace: string;
  projects: string[];
}

export interface NewKey {
  name: string;
  scope: Scope;
  reach: Reach;
  workspace?: string;
  projects?: string[];
  expires?: string;
}

export interface PendingUser {
  id: string;
  name: string;
  email: string;
  verified: boolean;
  approved: boolean;
  created: string;
}

export interface Workspace {
  id: string;
  name: string;
  role: string;
  status: string;
}

export interface ProjectRef {
  id: string;
  name: string;
}

export type Result<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      message: string;
      fields: Record<string, string>;
      status: number;
    };

const CHECK_EMAIL_REST =
  "Open it to choose your password; choosing it confirms your address. An administrator then approves new accounts before they can sign in.";

export const MESSAGES = {
  wrongCredentials: "Wrong email or password.",
  notReady:
    "This account cannot sign in yet. A new account can sign in once its password is chosen from the signup mail and an administrator has approved it.",
  tooMany: "Too many attempts. Wait a minute and try again.",
  unreachable: "The server could not be reached. Try again.",
  linkInvalid: "This link is invalid or has expired.",
  notAdmin: "This page is for app administrators.",
  accountGone: "That account no longer exists.",
  noKeys: "No keys yet.",
  noPending: "No accounts are waiting.",
  emailRequired: "Enter an email address.",
  passwordRequired: "Enter your password.",
  nameBlank: "Cannot be blank.",
  nameTooLong: "Use at most 255 characters.",
  passwordShort: "Use at least 8 characters.",
  passwordMismatch: "The passwords do not match.",
  keyName: "Use 1 to 200 characters.",
  workspaceRequired: "Choose the workspace this key is limited to.",
  projectsRequired: "Choose at least one project.",
  expiryPast: "Choose a date after today.",
  keyShownOnce: "Copy this key now. It is not shown again.",
  checkEmail: (email?: string) =>
    email
      ? `We sent a link to ${email}. ${CHECK_EMAIL_REST}`
      : `We sent a link to your email address. ${CHECK_EMAIL_REST}`,
  resetSent: (email: string) =>
    `If an account uses ${email}, a link to choose a new password is on its way.`,
  passwordSaved:
    "Password saved. You can sign in now; a new account can sign in once an administrator approves it.",
  emailConfirmed: "Email address confirmed. Choose a password to sign in.",
  revokeTitle: (name: string) => `Revoke key "${name}"?`,
  revokeBody:
    "Anything using this key stops working at once. This cannot be undone.",
  saved: "Saved.",
  checkEmailTitle: "Check your email",
  sendNewLink: "Send a new link",
  sendNewLinkIn: (seconds: number) => `Send a new link in ${seconds}s`,
  requestNewLink: "Request a new link",
  goToSignIn: "Go to sign in",
  choosePassword: "Choose a password",
};

// KEEP IN SYNC: pb_hooks/lib/oauth.js LEVEL_LABELS, the consent page's text (`Read: see your workspaces, projects and items.`).
export const LEVELS: { value: Scope; label: string }[] = [
  { value: "read", label: "Read: see your workspaces, projects and items." },
  {
    value: "write",
    label: "Read and write: also create, edit and comment on items.",
  },
  {
    value: "manage",
    label:
      "Manage: also change workspace settings, invitations and members, and empty the trash.",
  },
  {
    value: "own",
    label:
      "Own: also change roles, hand over or delete workspaces, and accept invitations.",
  },
];

const LEVEL_NAMES: Record<Scope, string> = {
  read: "Read",
  write: "Write",
  manage: "Manage",
  own: "Own",
};

export function levelName(scope: Scope): string {
  return LEVEL_NAMES[scope];
}

export function validateEmail(v: string): string | undefined {
  return !v.trim() || !v.includes("@") ? MESSAGES.emailRequired : undefined;
}

export function validatePassword(v: string): string | undefined {
  return v.length < 8 ? MESSAGES.passwordShort : undefined;
}

export function validatePasswordConfirm(
  password: string,
  confirm: string,
): string | undefined {
  return password !== confirm ? MESSAGES.passwordMismatch : undefined;
}

export function validateName(v: string): string | undefined {
  if (!v.trim()) return MESSAGES.nameBlank;
  return v.length > 255 ? MESSAGES.nameTooLong : undefined;
}

export function validateKeyName(v: string): string | undefined {
  const n = v.trim().length;
  return n < 1 || n > 200 ? MESSAGES.keyName : undefined;
}

export function expiresFromDate(day: string, now: Date): Result<string | null> {
  if (day === "") return { ok: true, value: null };
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? new Date(`${day}T00:00:00.000Z`)
    : null;
  const real =
    parsed !== null &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === day;
  if (real && day > now.toISOString().slice(0, 10))
    return { ok: true, value: `${day} 00:00:00.000Z` };
  return {
    ok: false,
    message: MESSAGES.expiryPast,
    fields: { expires: MESSAGES.expiryPast },
    status: 0,
  };
}

export function keyStatus(
  item: Pick<KeyItem, "revoked" | "expires">,
  now: Date,
): "Revoked" | "Expired" | "Active" {
  if (item.revoked) return "Revoked";
  if (
    item.expires !== "" &&
    Date.parse(item.expires.replace(" ", "T")) <= now.getTime()
  )
    return "Expired";
  return "Active";
}

export function formatDate(value: string): string {
  return value === "" ? "Never" : `${value.slice(0, 16)} UTC`;
}

export function reachLabel(
  item: Pick<KeyItem, "reach" | "workspace" | "projects">,
  workspaces: Workspace[],
): string {
  if (item.reach === "all") return "All workspaces";
  const name =
    workspaces.find((w) => w.id === item.workspace)?.name ?? item.workspace;
  if (item.reach === "workspace") return name;
  const n = item.projects.length;
  return `${n} ${n === 1 ? "project" : "projects"} in ${name}`;
}

export function pendingStatus(
  user: Pick<PendingUser, "verified" | "approved">,
): string {
  if (user.approved) return "Waiting for email confirmation";
  return user.verified
    ? "Waiting for approval"
    : "Email not confirmed; waiting for approval";
}

export function safeRedirect(v: unknown): string | undefined {
  return typeof v === "string" && v.startsWith("/") && !v.startsWith("//")
    ? v
    : undefined;
}

export function errorResult(err: unknown): Result<never> {
  const failed = (message: string, status: number, fields = {}) => ({
    ok: false as const,
    message,
    fields,
    status,
  });
  if (!(err instanceof ClientResponseError) || err.status === 0)
    return failed(MESSAGES.unreachable, 0);
  if (err.status === 429) return failed(MESSAGES.tooMany, 429);
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(err.response.data ?? {}))
    fields[key] = (value as { message: string }).message;
  return failed(err.response.message, err.status, fields);
}

export function client(url: string, store?: BaseAuthStore): PocketBase {
  return new PocketBase(url, store);
}
