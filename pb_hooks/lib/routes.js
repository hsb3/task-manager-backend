/// <reference path="../../pb_data/types.d.ts" />
// The one place a custom route registers: the table is what openapi.json documents (scripts/gen_openapi.ts reads it) and the only routerAdd call site (scripts/check_route_registry.ts refuses another).

// auth: "any" = any signed-in auth record (user, API key or superuser) · "users" = a signed-in user (an API key acts as its user) · "superuser" = superusers only · "none" = no sign-in.
// internal: true = reachable only by the server itself (loopback); left out of openapi.json on purpose.
// request = the body the handler reads · query = the query parameters the handler reads · responses = the error statuses the handler itself returns, each one line, answered with the shared Error body · denies: ["superuser"] = refused in the handler with 403 · docs = the app_docs slug whose body leads the description.
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
    responses: {
      404: "A caller who is not an app administrator gets 404, the same status a route that does not exist answers.",
    },
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
    responses: {
      404: "A caller who is not an app administrator gets 404, the same status a route that does not exist answers; an administrator gets 404 for an unknown account.",
    },
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
    docs: "route:tracker-export",
    request: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "The workspace id." },
        projects: {
          type: ["array", "null"],
          items: { type: "string" },
          description:
            "Project ids that narrow the export; null or empty exports every readable project.",
        },
        collections: {
          type: ["array", "null"],
          items: { type: "string" },
          description:
            "Collection names that narrow the export; null or empty exports the default set.",
        },
      },
      required: ["workspace"],
    },
    responses: {
      400: "The workspace is missing or blank, or projects or collections is neither null nor a list of strings.",
      404: "The workspace does not exist, is in the trash, or the caller is neither its owner nor an active member.",
    },
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
    docs: "route:tracker-inspire",
    responses: {
      502: "The outside quote service could not be reached or gave no usable quote; try again later.",
    },
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
    responses: {
      403: "The caller has not confirmed their email address; a superuser and a read-only API key get 403 too.",
      404: "The invitation does not exist, is not addressed to the caller, was already used, or its workspace is in the trash.",
      410: "The invitation has expired.",
    },
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
    responses: {
      404: "The invitation does not exist, is not addressed to the caller, was already used, or its workspace is in the trash.",
    },
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
    denies: ["superuser"],
    docs: "route:tracker-me",
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
    query: {
      workspace: {
        type: "string",
        description:
          "Marks only that workspace's notifications and those tied to no workspace; omitted marks every unread notification.",
      },
    },
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
    denies: ["superuser"],
    query: {
      group: {
        type: "string",
        required: true,
        enum: ["project", "status", "priority", "assignee", "label", "type"],
        description: "What the items are counted by.",
      },
      filter: {
        type: "string",
        description:
          "A filter over the items' own fields, at most 3500 characters, narrowing what is counted.",
      },
    },
    responses: {
      400: "The group is missing or not one of the listed ones, or the filter is longer than 3500 characters, reaches past the items' own fields, names a field the items do not have, or is not a valid filter.",
      500: "The items' access rule is missing or cannot be applied per caller, so nothing can be counted.",
    },
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
    query: {
      q: {
        type: "string",
        description:
          "The text to find in titles and bodies, ignoring case; omitted or blank answers no results.",
      },
      workspace: {
        type: "string",
        description:
          "Narrows the search to one workspace id. Omitted searches every workspace the caller can read; present but blank is refused.",
      },
    },
    responses: {
      400: "The workspace parameter is present but blank.",
    },
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
    docs: "route:tracker-summary",
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
    denies: ["superuser"],
    docs: "route:tracker-trash",
    query: {
      workspace: {
        type: "string",
        required: true,
        description: "The workspace id whose trash is listed.",
      },
      filter: {
        type: "string",
        description:
          "A filter over the items' own fields, at most 3500 characters, narrowing the list.",
      },
      sort: {
        type: "string",
        description:
          "A comma list of the items' fields, each optionally prefixed - or +; most recently trashed first when omitted. Ignored with group.",
      },
      group: {
        type: "string",
        enum: ["project", "status", "priority", "assignee", "label", "type"],
        description:
          "Counts the trashed items per group instead of listing them.",
      },
      time_zone: {
        type: "string",
        description:
          "An IANA time zone name such as Europe/Paris, the day purge_days counts from; the caller's saved time zone wins over it.",
      },
      page: {
        type: "integer",
        description:
          "The page to return, from 1; a missing or smaller value reads as 1.",
      },
      perPage: {
        type: "integer",
        description:
          "Items per page, from 1 to 500; omitted is 500 and a value outside is brought to the nearer end.",
      },
    },
    responses: {
      400: "The workspace is missing or blank, or the filter, sort, group or time zone is refused: a filter longer than 3500 characters, a filter or sort that reaches past the items' own fields, a group outside the listed ones, or a time zone that is not an IANA name.",
      403: "The caller is a superuser, who is no member of any workspace; the same refusal the other member-only workspace routes answer.",
      404: "The workspace does not exist, is in the trash, or the caller is neither its owner nor an active member; its owner gets 404 for a trashed workspace too.",
      500: "The trashed items could not be read for a reason other than the filter or sort.",
    },
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
    docs: "route:tracker-user-settings",
    responses: {
      404: "The id in the path is not the caller; another account gets the same answer as an unknown id.",
    },
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          display_name: { type: "string" },
          theme: { type: "string" },
          font: { type: "string" },
          font_size: { type: "integer", description: "0 when unset." },
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
    docs: "route:tracker-user-settings",
    request: {
      type: "object",
      properties: {
        display_name: { type: "string" },
        theme: { type: "string", enum: ["light", "dark", "system"] },
        font: { type: "string", enum: ["system", "sans", "mono"] },
        font_size: {
          type: "integer",
          minimum: 0,
          maximum: 24,
          description: "From 12 to 24, or 0 to clear it.",
        },
        default_view: {
          type: "string",
          description: "A saved view id the caller can read; empty clears it.",
        },
        default_project: {
          type: "string",
          description:
            "A project id the caller can read, never a hidden shadow project; empty clears it.",
        },
        time_zone: {
          type: "string",
          description:
            "An IANA time zone name such as Europe/Paris; empty clears it.",
        },
      },
      additionalProperties: false,
      minProperties: 1,
    },
    responses: {
      400: "The body is empty, names a key not listed here, or holds a value the settings or the display name refuse; nothing is saved.",
      403: "An API key tried to change the display name; a superuser and a read-only API key get 403 too.",
      404: "The id in the path is not the caller; another account gets the same answer as an unknown id.",
    },
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          display_name: { type: "string" },
          theme: { type: "string" },
          font: { type: "string" },
          font_size: { type: "integer", description: "0 when unset." },
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
    docs: "route:workspaces-trash",
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
    docs: "route:workspaces-deletion-impact",
    responses: {
      404: "The workspace does not exist or the caller is not its owner; an admin and a superuser get 404 too.",
    },
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
      "Invites an email address to the workspace with a role, or sends a pending invitation to it again, answering the same whether or not the address has an account.",
    auth: "any",
    request: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description:
            "Any non-blank text; the server stores it trimmed and in lower case without checking its shape.",
        },
        role: {
          type: "string",
          enum: ["admin", "member", "viewer"],
          default: "member",
          description:
            "Only the owner may invite an admin or a viewer; an active admin invites members.",
        },
      },
      required: ["email"],
    },
    responses: {
      400: "The email is missing or blank, the role is not admin, member or viewer, a caller who is not the owner asked for an admin or a viewer, or the body carries expected_updated_at.",
      404: "The workspace does not exist, is in the trash, or the caller is neither its owner nor an active admin.",
      409: "The address recently declined an invitation to this workspace; invite it again later.",
      429: "The daily invitation limit of the inviter is reached, or the same pending invitation was sent again less than a minute ago; wait before inviting again.",
    },
    response: {
      status: 200,
      schema: {
        type: "object",
        properties: {
          invited: { type: "boolean" },
          mail_sent: {
            type: "boolean",
            description:
              "True when the invitation email is being sent; false when no mail server is configured.",
          },
        },
        required: ["invited", "mail_sent"],
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
    summary: "Hands a workspace to another active member who is not a viewer.",
    auth: "any",
    docs: "route:workspaces-transfer-ownership",
    request: {
      type: "object",
      properties: {
        user: {
          type: "string",
          description:
            "The id of the new owner, an active member who is not a viewer.",
        },
        current_owner: {
          type: "string",
          description:
            "Required of a superuser: the id of the person who owns the workspace now. Ignored for anyone else.",
        },
      },
      required: ["user"],
    },
    responses: {
      400: "The user is missing, already the owner, not an active member, or a viewer; the workspace is in the trash; or a superuser named no current owner or the wrong one.",
      404: "The workspace does not exist or the caller is neither its owner nor a superuser.",
    },
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
    docs: "route:workspaces-vocab",
    request: {
      type: "object",
      description:
        "Every part is optional; any other top-level key, owner and trashed included, is ignored.",
      properties: {
        name: { type: "string" },
        priorities: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
            required: ["name"],
          },
        },
        default_project: {
          type: "string",
          description: "A project id in this workspace.",
        },
        statuses: {
          type: "array",
          description:
            "The full list in position order: an entry with an id renames that status, one without adds a status, and a status left out is deleted.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              terminal: {
                type: "boolean",
                description: "True for a status that ends the work.",
              },
              off_pipeline: {
                type: "boolean",
                description:
                  "Only false is accepted; true is refused with 400.",
              },
            },
            required: ["name"],
          },
        },
        labels: {
          type: "array",
          description:
            "The full list: an entry with an id renames that label, one without adds a label, and a label left out is deleted.",
          items: {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
            required: ["name"],
          },
        },
      },
    },
    responses: {
      400: "A workspace field, status or label is refused, or the call would delete a status a task still uses or a core label; nothing is saved.",
      404: "The workspace does not exist, is in the trash, or the caller is neither its owner nor an active admin.",
    },
    response: {
      status: 200,
      schema: {
        $ref: "#/components/schemas/WorkspacesRecord",
        description:
          "expand carries statuses_via_workspace (by position) and labels_via_workspace (by creation).",
      },
    },
  },
  "POST /internal/invitation-mail/{id}": {
    summary:
      "Sends an invitation email; called by the server itself after an invitation is created and refuses any other caller.",
    auth: "none",
    internal: true,
    response: { status: 204, schema: null },
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
// Middleware reaches the router only here (scripts/check_route_registry.ts refuses a routerUse elsewhere).
function use(...args) {
  routerUse(...args);
}

module.exports = { ROUTES, add, use };
