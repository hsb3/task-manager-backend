/// <reference path="../../pb_data/types.d.ts" />
// The one place a custom route registers: the table is what openapi.json documents (scripts/gen_openapi.ts reads it) and the only routerAdd call site (scripts/check_route_registry.ts refuses another).

// auth: "any" = any signed-in auth record (user, API key or superuser) · "users" = a signed-in user (an API key acts as its user) · "superuser" = superusers only · "none" = no sign-in.
// internal: true = reachable only by the server itself (loopback); left out of openapi.json on purpose.
const ROUTES = {
  "GET /admin": {
    summary: "Redirects to the admin dashboard.",
    auth: "none",
    response: { status: 302, schema: null },
  },
  "GET /api/tracker/admin/pending-users": {
    summary:
      "Lists the accounts still waiting for approval or for email confirmation; for app administrators only.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          count: { type: "integer" },
          users: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                email: { type: "string" },
                verified: { type: "boolean" },
                approved: { type: "boolean" },
                created: { type: "string" },
              },
              required: [
                "id",
                "name",
                "email",
                "verified",
                "approved",
                "created",
              ],
            },
          },
        },
        required: ["count", "users"],
      },
    },
  },
  "POST /api/tracker/admin/pending-users/{id}/approve": {
    summary:
      "Approves a pending account so it can sign in; for app administrators only.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          approved: { type: "boolean" },
        },
        required: ["id", "approved"],
      },
    },
  },
  "POST /api/tracker/cycles/rollover": {
    summary:
      "Moves the unfinished tasks of every ended cycle into the next cycle now, instead of waiting for the daily run.",
    auth: "superuser",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          rolled: {
            type: "integer",
            description: "How many tasks were moved to a later cycle.",
          },
        },
        required: ["rolled"],
      },
    },
  },
  "POST /api/tracker/export": {
    summary:
      "Exports one workspace as JSON, holding only what the caller may read in it.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          format_version: { type: "integer" },
          exported_at: { type: "string" },
          workspace: { type: "string" },
          scope: {
            type: "object",
            properties: {
              projects: { type: "array", items: { type: "string" } },
              collections: { type: "array", items: { type: "string" } },
            },
            required: ["projects", "collections"],
          },
          data: {
            type: "object",
            description:
              "One array of rows per exported collection, keyed by collection name, plus users: the accounts those rows reference.",
          },
        },
        required: [
          "format_version",
          "exported_at",
          "workspace",
          "scope",
          "data",
        ],
      },
    },
  },
  "GET /api/tracker/inspire": {
    summary:
      "Returns a random quote and its author from an outside quote service.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          quote: { type: "string" },
          author: { type: "string" },
          source: { type: "string" },
        },
        required: ["quote", "author", "source"],
      },
    },
  },
  "GET /api/tracker/invitations/mine": {
    summary:
      "Lists the invitations addressed to the caller's email, each with its workspace, role and expiry.",
    auth: "users",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                workspace: { type: "string" },
                workspace_name: { type: "string" },
                role: { type: "string" },
                created: { type: "string" },
                expires_at: { type: "string" },
                expired: { type: "boolean" },
              },
              required: [
                "id",
                "workspace",
                "workspace_name",
                "role",
                "created",
                "expires_at",
                "expired",
              ],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  "POST /api/tracker/invitations/{id}/accept": {
    summary:
      "Accepts an invitation addressed to the caller and joins its workspace.",
    auth: "users",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          workspace: { type: "string" },
          membership: {
            type: ["string", "null"],
            description: "Null when the caller owns the workspace.",
          },
          role: { type: "string" },
          status: { type: "string" },
        },
        required: ["workspace", "membership", "role", "status"],
      },
    },
  },
  "POST /api/tracker/invitations/{id}/decline": {
    summary: "Declines an invitation addressed to the caller.",
    auth: "users",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: { declined: { type: "boolean" } },
        required: ["declined"],
      },
    },
  },
  "GET /api/tracker/me": {
    summary: "The caller, their workspaces and what they may do in each.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
            required: ["id", "name"],
          },
          unread_notifications: { type: "integer" },
          workspaces: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: ["string", "null"] },
                role: { type: "string" },
                status: { type: "string" },
                counts: {
                  type: ["object", "null"],
                  description:
                    "{projects, open_items}; null for a suspended membership.",
                },
                capabilities: {
                  type: "object",
                  description: "{write, manage, own}, each a boolean.",
                },
              },
              required: [
                "id",
                "name",
                "role",
                "status",
                "counts",
                "capabilities",
              ],
            },
          },
        },
        required: ["user", "unread_notifications", "workspaces"],
      },
    },
  },
  "GET /api/tracker/me/landing": {
    summary: "The workspace the signed-in user should land on, and why.",
    auth: "users",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          landing: {
            type: ["object", "null"],
            description: "Null when the user has no workspace to land on.",
            properties: {
              workspace: { type: "string" },
              reason: {
                type: "string",
                enum: ["owned", "member", "invitation", "suspended"],
              },
              invitation: { type: ["string", "null"] },
            },
            required: ["workspace", "reason", "invitation"],
          },
        },
        required: ["landing"],
      },
    },
  },
  "POST /api/tracker/notifications/read-all": {
    summary:
      "Marks the caller's unread notifications as read, optionally only those of one workspace.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          updated: {
            type: "integer",
            description: "How many notifications were marked read.",
          },
        },
        required: ["updated"],
      },
    },
  },
  "GET /api/tracker/project-items/counts": {
    summary:
      "Counts the items the caller can see, grouped by project, status, priority, assignee, label or type.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: ["string", "null"] },
                count: { type: "integer" },
              },
              required: ["key", "count"],
            },
          },
          total: { type: "integer" },
        },
        required: ["items", "total"],
      },
    },
  },
  "GET /api/tracker/search": {
    summary:
      "Searches the tasks, decisions, documents, milestones and projects the caller can read by title and text.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          count: { type: "integer" },
          truncated: { type: "boolean" },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                collection: { type: "string" },
                id: { type: "string" },
                title: { type: "string" },
                project: { type: "string" },
                rank: { type: "integer" },
              },
              required: ["collection", "id", "title", "project", "rank"],
            },
          },
        },
        required: ["query", "count", "truncated", "results"],
      },
    },
  },
  "GET /api/tracker/summary": {
    summary:
      "Counts the caller's tasks in total, by status and assigned to them.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          user: { type: "string", description: "The caller's name." },
          total: { type: "integer" },
          byStatus: {
            type: "object",
            description: "Task count per status id.",
            additionalProperties: { type: "integer" },
          },
          assignedToMe: { type: "integer" },
        },
        required: ["user", "total", "byStatus", "assignedToMe"],
      },
    },
  },
  "GET /api/tracker/trash": {
    summary:
      "Lists the trashed items of one workspace a page at a time, or counts them in groups.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        anyOf: [
          {
            type: "object",
            description: "Without group: one page of trashed items.",
            properties: {
              workspace: { type: "string" },
              count: { type: "integer" },
              page: { type: "integer" },
              perPage: { type: "integer" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    collection: {
                      type: "string",
                      enum: ["tasks", "decisions", "documents", "milestones"],
                    },
                    record: {
                      description:
                        "The trashed record, with its relations expanded.",
                      anyOf: [
                        { $ref: "#/components/schemas/TasksRecord" },
                        { $ref: "#/components/schemas/DecisionsRecord" },
                        { $ref: "#/components/schemas/DocumentsRecord" },
                        { $ref: "#/components/schemas/MilestonesRecord" },
                      ],
                    },
                    purge_at: { type: "string" },
                    purge_days: { type: "integer" },
                    has_priority: { type: "boolean" },
                  },
                  required: [
                    "collection",
                    "record",
                    "purge_at",
                    "purge_days",
                    "has_priority",
                  ],
                },
              },
            },
            required: ["workspace", "count", "page", "perPage", "items"],
          },
          {
            type: "object",
            description: "With group: the trashed items counted per group.",
            properties: {
              workspace: { type: "string" },
              total: { type: "integer" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    key: { type: ["string", "null"] },
                    count: { type: "integer" },
                  },
                  required: ["key", "count"],
                },
              },
            },
            required: ["workspace", "total", "items"],
          },
        ],
      },
    },
  },
  "POST /api/tracker/trash/purge": {
    summary:
      "Permanently deletes everything that has been in the trash longer than the retention period now, instead of waiting for the daily run.",
    auth: "superuser",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          purged: {
            type: "integer",
            description:
              "How many trashed workspaces, projects and items this run deleted; rows deleted along with one of them are not counted.",
          },
        },
        required: ["purged"],
      },
    },
  },
  "GET /api/tracker/users/{id}/settings": {
    summary: "The caller's display name and personal settings.",
    auth: "users",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          display_name: { type: "string" },
          theme: { type: "string" },
          font: { type: "string" },
          font_size: { type: "integer" },
          default_view: { type: "string" },
          default_project: { type: "string" },
          time_zone: { type: "string" },
        },
        required: [
          "display_name",
          "theme",
          "font",
          "font_size",
          "default_view",
          "default_project",
          "time_zone",
        ],
      },
    },
  },
  "PATCH /api/tracker/users/{id}/settings": {
    summary:
      "Saves the caller's display name and personal settings together and returns them.",
    auth: "users",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          display_name: { type: "string" },
          theme: { type: "string" },
          font: { type: "string" },
          font_size: { type: "integer" },
          default_view: { type: "string" },
          default_project: { type: "string" },
          time_zone: { type: "string" },
        },
        required: [
          "display_name",
          "theme",
          "font",
          "font_size",
          "default_view",
          "default_project",
          "time_zone",
        ],
      },
    },
  },
  "GET /api/tracker/workspaces/trash": {
    summary: "The trashed workspaces the caller owns or administers.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          count: { type: "integer" },
          truncated: { type: "boolean" },
          items: {
            type: "array",
            items: { $ref: "#/components/schemas/WorkspacesRecord" },
          },
        },
        required: ["count", "truncated", "items"],
      },
    },
  },
  "GET /api/tracker/workspaces/{id}/deletion-impact": {
    summary:
      "What deleting a workspace would take with it, counted for its owner.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          items: { type: "integer" },
          trashed_items: { type: "integer" },
          projects: { type: "integer" },
          members: { type: "integer" },
          saved_views: { type: "integer" },
        },
        required: [
          "items",
          "trashed_items",
          "projects",
          "members",
          "saved_views",
        ],
      },
    },
  },
  "POST /api/tracker/workspaces/{id}/resolve-member-email": {
    summary:
      "Invites an email address to the workspace with a role, answering the same whether or not the address has an account.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: { invited: { type: "boolean" } },
        required: ["invited"],
      },
    },
  },
  "GET /api/tracker/workspaces/{id}/switch": {
    summary:
      "Whether the signed-in user may switch to the named workspace and, if not, why and whether an invitation to it waits.",
    auth: "users",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          workspace: { type: "string" },
          allowed: { type: "boolean" },
          reason: {
            type: ["string", "null"],
            enum: ["not_found", "suspended", null],
          },
          invitation: {
            type: ["object", "null"],
            properties: {
              id: { type: "string" },
              expired: { type: "boolean" },
            },
            required: ["id", "expired"],
          },
        },
        required: ["workspace", "allowed", "reason", "invitation"],
      },
    },
  },
  "POST /api/tracker/workspaces/{id}/transfer-ownership": {
    summary: "Hands a workspace to one of its active members.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    },
  },
  "POST /api/tracker/workspaces/{id}/vocab": {
    summary:
      "Saves a workspace together with its statuses and labels and returns the saved workspace with both lists.",
    auth: "any",
    response: {
      status: 200,
      schema: {
        $ref: "#/components/schemas/WorkspacesRecord",
        description:
          "expand carries statuses_via_workspace (by position) and labels_via_workspace (by creation).",
      },
    },
  },
  "POST /internal/signup-verification/{id}": {
    summary:
      "Sends a new account's confirmation email; called by the server's own signup mail step and refuses any other caller.",
    auth: "none",
    internal: true,
    response: { status: 204, schema: null },
  },
};
const MIDDLEWARE = {
  any: () => [$apis.requireAuth()],
  users: () => [$apis.requireAuth("users")],
  superuser: () => [$apis.requireSuperuserAuth()],
  none: () => [],
};
function add(key, handler) {
  const spec = ROUTES[key];
  if (!spec)
    throw new Error(
      `route ${key} is not in the registry (pb_hooks/lib/routes.js)`,
    );
  const sp = key.indexOf(" ");
  routerAdd(
    key.slice(0, sp),
    key.slice(sp + 1),
    handler,
    ...MIDDLEWARE[spec.auth](),
  );
}
module.exports = { ROUTES, add };
