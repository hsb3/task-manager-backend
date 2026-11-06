/// <reference path="../pb_data/types.d.ts" />
// Every field a client reads or sends carries one sentence of help text; the API spec shows it as the property description (kata xqxh).
// Excluded: system fields (id and the auth built-ins) and the autodate stamps created/updated, which the server owns identically everywhere.
const HELP = {
  api_keys: {
    user: "The account this key acts as; leave it empty and the server fills the signed-in caller, while naming another user is refused.",
    name: "A label to tell your keys apart, up to 200 characters, stored trimmed; it may be renamed later.",
    scope:
      "What the key may do: read allows only reads, write also allows changes; chosen at create and fixed afterwards.",
    key_hash:
      "A fingerprint of the key, filled by the server and never shown to clients; a value sent at create is replaced and a later change is refused.",
    expires:
      "When the key stops working, or empty for a key that never expires; it can be set only at create.",
    revoked:
      "Set to true to switch the key off for good; a revoked key cannot be switched back on.",
  },
  app_docs: {
    slug: "The unique address of this entry, such as collection:tasks or decision:soft-delete-trash; entries are read-only for clients.",
    title: "A one-line summary of the entry; read-only for clients.",
    refName:
      "The name of the collection this entry is mainly about, such as tasks, or empty when it concerns none; read-only for clients.",
    body: "The full text of the entry in markdown; read-only for clients.",
  },
  app_settings: {
    key: "The name of the setting, such as trash_retention_days; unique, and read-only for clients.",
    value:
      "The value of the setting as JSON, usually a number such as 30; every signed-in user may read it and no client may change it.",
  },
  comments: {
    task: "The task this comment is on; send exactly one of task, document or decision at create, and it cannot be changed afterwards.",
    author:
      "The user who wrote the comment, filled by the server from the signed-in caller; a value sent at create is replaced and a later change is refused.",
    body: "The comment text, up to 5000 characters, stored trimmed; text of only spaces is refused, and changing it marks the comment edited.",
    parent:
      "The top-level comment on the same item that this one replies to, or empty to start a thread; replies do not nest and it cannot be changed later.",
    reactions:
      "A JSON object mapping each emoji to an array of user ids; each caller may add or remove only their own id.",
    edited:
      "True once the body has been changed after posting; the server sets it, and a value sent is ignored.",
    document:
      "The document this comment is on; send exactly one of task, document or decision at create, and it cannot be changed afterwards.",
    decision:
      "The decision this comment is on; send exactly one of task, document or decision at create, and it cannot be changed afterwards.",
  },
  cycles: {
    name: "The cycle name, up to 200 characters, stored trimmed; a cycle the server starts on its own is named after its start date.",
    workspace:
      "The workspace this cycle belongs to; required at create and cannot be changed afterwards.",
    starts_on:
      "The first day of the cycle; the time of day is dropped, and two cycles of one workspace may not overlap.",
    ends_on:
      "The last day of the cycle, after starts_on; leave it empty at create and the server sets it to two weeks after the start.",
  },
  decisions: {
    title: "The headline of the decision, stored trimmed; a title of only spaces is refused.",
    status:
      "A free-text word for where the decision stands, up to 50 characters; any text is accepted.",
    context:
      "The background that led to the decision; an @mention of a workspace member notifies them once the decision is published.",
    decision:
      "What was decided; an @mention of a workspace member notifies them once the decision is published.",
    consequences:
      "What follows from the decision; an @mention of a workspace member notifies them once the decision is published.",
    workspace:
      "The workspace this decision belongs to; it may be omitted when a project is sent, and it cannot be changed afterwards.",
    trashed:
      "When the decision was moved to the trash, set by the server on DELETE; send it empty only to restore the decision, any other change is refused.",
    project:
      "The project this decision sits in, which must be a project of the same workspace; if omitted it lands in the hidden project for unfiled items.",
    draft:
      "True while only the author, the workspace owner and admins can see it; send false to publish, which cannot be undone.",
    trashed_by:
      "The user who moved the decision to the trash, set by the server; a value sent at create is dropped, and it may only be cleared on restore.",
    author:
      "The user who created the decision, filled by the server from the signed-in caller; a value sent is replaced and a later change is refused.",
    attachments:
      "Up to 10 images or PDFs of 10 MB each; downloading one needs a short-lived file token.",
    key: "The display key such as ENG-42, assigned by the server and fixed for life, empty outside a project; a value sent is ignored at create and refused later.",
  },
  documents: {
    title: "The title of the document, stored trimmed; a title of only spaces is refused.",
    body: "The document text in markdown, stored as sent; an @mention of a workspace member notifies them once the document is published.",
    workspace:
      "The workspace this document belongs to; it may be omitted when a project is sent, and it cannot be changed afterwards.",
    trashed:
      "When the document was moved to the trash, set by the server on DELETE; send it empty only to restore the document, any other change is refused.",
    project:
      "The project this document sits in, which must be a project of the same workspace; if omitted it lands in the hidden project for unfiled items.",
    draft:
      "True while only the author, the workspace owner and admins can see it; send false to publish, which cannot be undone.",
    trashed_by:
      "The user who moved the document to the trash, set by the server; a value sent at create is dropped, and it may only be cleared on restore.",
    author:
      "The user who created the document, filled by the server from the signed-in caller; a value sent is replaced and a later change is refused.",
    attachments:
      "Up to 10 images or PDFs of 10 MB each; downloading one needs a short-lived file token.",
    key: "The display key such as ENG-42, assigned by the server and fixed for life, empty outside a project; a value sent is ignored at create and refused later.",
  },
  invitation_events: {
    kind: "Whether the row records an invitation sent (mint) or declined (decline); written by the server and never readable by clients.",
    inviter:
      "The user who sent the invitation, on a mint row; written by the server and never readable by clients.",
    workspace:
      "The workspace the invitation was for, emptied if that workspace is deleted; written by the server and never readable by clients.",
    email_key:
      "The normalised invited address used to count sends and declines; written by the server and never readable by clients.",
  },
  labels: {
    workspace:
      "The workspace this label belongs to; required at create and cannot be changed afterwards.",
    project:
      "The project this label is limited to, which must be a project of the same workspace; leave it empty for a label of the whole workspace.",
    name: "The label name, stored trimmed and unique within its workspace or project; a name of only spaces is refused.",
    color: "The display color, from the shared palette; optional.",
    description: "Optional text explaining when to use the label.",
    core: "True for the built-in labels every workspace starts with, which cannot be deleted; leave it unset on a label you create.",
  },
  milestones: {
    name: "The milestone name, stored trimmed; a name of only spaces is refused.",
    description: "Optional text describing what the milestone delivers.",
    workspace:
      "The workspace this milestone belongs to; it may be omitted when a project is sent, and it cannot be changed afterwards.",
    trashed:
      "When the milestone was moved to the trash, set by the server on DELETE; send it empty only to restore the milestone, any other change is refused.",
    project:
      "The project this milestone belongs to, which must be a project of the same workspace; if omitted it lands in the hidden project for unfiled items, with no key.",
    draft:
      "True while only the author, the workspace owner and admins can see it; send false to publish, which cannot be undone.",
    target:
      "The day the milestone aims to be done by; optional, and a value that is not a date is stored as empty.",
    trashed_by:
      "The user who moved the milestone to the trash, set by the server; a value sent at create is dropped, and it may only be cleared on restore.",
    author:
      "The user who created the milestone, filled by the server from the signed-in caller; a value sent is replaced and a later change is refused.",
    attachments:
      "Up to 10 images or PDFs of 10 MB each; downloading one needs a short-lived file token.",
    key: "The display key such as ENG-42, assigned by the server and fixed for life, empty outside a project; a value sent is ignored at create and refused later.",
  },
  notifications: {
    user: "The recipient of the notification, set by the server; a change sent is refused.",
    task: "The task the notification is about, set by the server; a change sent is refused.",
    kind: "What happened: an assignment, a comment, a task completed, a mention, or a change of workspace owner; set by the server.",
    read: "Whether the recipient has read the notification; the recipient may set it to true or false.",
    snoozed_until:
      "A time until which the recipient sets the notification aside; the recipient may set or clear it.",
    comment:
      "The comment that raised the notification, on comment rows and on mentions made in a comment; set by the server.",
    comment_preview:
      "The first 140 characters of the comment when the notification was written; set by the server and not updated by later edits.",
    status_label:
      "The name of the status the task moved into, on a completed-task notification; set by the server.",
    document:
      "The document the notification is about, set by the server; a change sent is refused.",
    decision:
      "The decision the notification is about, set by the server; a change sent is refused.",
    workspace:
      "The workspace the notification concerns, set by the server; filter on it to show the inbox of one workspace.",
    dismissed:
      "True once the recipient dismisses the notification, which hides it from the inbox; setting it back to false shows it again.",
    actor:
      "The user whose action raised the notification, empty when a superuser acted; set by the server.",
    read_at:
      "When the notification was last marked read; the server sets it and clears it when marked unread, and a value sent is refused.",
  },
  projects: {
    name: "The project name, stored trimmed; a name of only spaces is refused.",
    description: "Optional text describing the project.",
    owner:
      "The user who created the project, for display only; leave it empty and the server fills the caller, and it cannot be changed later.",
    workspace:
      "The workspace this project belongs to; required at create and cannot be changed afterwards.",
    trashed:
      "When the project was moved to the trash by DELETE; send it empty to restore the project with its items, any other change is refused.",
    key: "The prefix of item keys, up to 8 uppercase letters and digits, unique in the workspace; suggested from the name when omitted and fixed after create.",
    item_seq:
      "The counter behind the item numbers of this project, kept by the server; a change sent is refused.",
    shadow:
      "Marks the hidden home of items that have no project; only the server sets it, and a request that sends it is refused.",
  },
  saved_views: {
    workspace:
      "The workspace this view belongs to; required at create and cannot be changed afterwards.",
    owner:
      "The user who owns the view; leave it empty and the server fills the caller, and naming anyone else at create is refused.",
    name: "The view name, stored trimmed; a name of only spaces is refused.",
    filterData:
      "The saved filter as a JSON array of clause objects, each with field, op and value.",
    scope:
      "Who can see the view: personal for its owner only, workspace for every active member of the workspace.",
    description: "Optional text describing what the view shows.",
    columns: "The visible columns as an ordered JSON array of column keys.",
    density: "The row spacing of the view; empty means cozy.",
    mode: "Whether the view shows a list or a board; empty means list.",
    group_by: "What the rows are grouped by; empty means none.",
    sort: "The sort order as a JSON object with a field and an order.",
    position: "A number placing this view among the saved views.",
    project:
      "The project the view is limited to, which must be a project of the same workspace; leave it empty to span the whole workspace.",
  },
  statuses: {
    workspace:
      "The workspace this status belongs to; required at create and cannot be changed afterwards.",
    name: "The status name, stored trimmed and unique in the workspace; a name of only spaces is refused.",
    category:
      "The stage the status stands for; completed and canceled count as finished, and entering completed stamps the task completion time.",
    color: "The display color, from the shared palette; optional.",
    position: "The order of the status among the board columns, as a whole number.",
    is_default:
      "True for the status a new task gets when none is sent; at most one status per workspace may be the default.",
  },
  task_activity: {
    task: "The task whose field changed, empty on a change of workspace owner; written by the server only.",
    actor:
      "The user who made the change, empty for a superuser or a system change; written by the server only.",
    field:
      "The name of the field that changed, such as status, or owner for a change of workspace owner; written by the server only.",
    from: "The old value as JSON text, such as a quoted id; written by the server only.",
    to: "The new value as JSON text, such as a quoted id; written by the server only.",
    workspace:
      "The workspace the change belongs to, which anchors rows that name no task; written by the server only.",
    operator:
      "The email of the superuser who made the change, empty for user and system changes; written by the server only.",
  },
  task_subscribers: {
    task: "The task to follow; it must be a task the caller can see, outside the trash.",
    user: "The subscribed user; a client may subscribe only itself, so send the id of the signed-in user.",
  },
  tasks: {
    title: "The task title, stored trimmed; a title of only spaces is refused.",
    project:
      "The project this task belongs to, in the same workspace; when omitted a subtask takes the project of its parent and any other task lands in the hidden project for unfiled items.",
    assignee:
      "The user responsible for the task, who must be the workspace owner or an active member; it stays empty unless sent.",
    due: "The day the task is due; optional.",
    milestone:
      "The milestone this task counts toward, which must be in the same project as the task.",
    parent:
      "The task this one is a subtask of, which must be in the same project and cannot be the task itself.",
    ordinal:
      "The place of the task in its board column; the server sets it at create, ignoring a value sent, and a client may change it later.",
    acceptanceCriteria:
      "The checklist of the task as a JSON array of objects, each with text and done.",
    dependencies:
      "The tasks that block this one; each must be in the same project and cannot be this task, its parent or one of its subtasks.",
    attachments:
      "Up to 10 images or PDFs of 10 MB each; downloading one needs a short-lived file token.",
    description: "The task text; an @mention of a workspace member notifies them.",
    priority:
      "The id of an entry in the priority list of the workspace, or empty for no priority; a priority name is refused.",
    type: "A free-text category for the task, up to 50 characters; optional, and any text is accepted.",
    trashed:
      "When the task was moved to the trash, set by the server on DELETE; send it empty only to restore the task, any other change is refused.",
    workspace:
      "The workspace this task belongs to; it may be omitted when a project is sent, and it cannot be changed afterwards.",
    status:
      "The workflow status, which must be a status of the same workspace; the workspace default is used when it is omitted.",
    labels: "The labels on the task, each of which must be a label of the same workspace.",
    completedAt:
      "When the task entered a completed status; the server sets and clears it as the status changes, so a client should not send it.",
    trashed_by:
      "The user who moved the task to the trash, set by the server; a value sent at create is dropped, and it may only be cleared on restore.",
    key: "The display key such as ENG-42, assigned by the server and fixed for life, empty outside a project; a value sent is ignored at create and refused later.",
    cycle:
      "The cycle the task is planned in, which must be a cycle of the same workspace; an unfinished task moves on when its cycle ends.",
    author:
      "The user who created the task, filled by the server from the signed-in caller; a value sent is replaced and a later change is refused.",
  },
  templates: {
    workspace:
      "The workspace this template belongs to; required at create and cannot be changed afterwards.",
    project:
      "The project this template is limited to, which must be a project of the same workspace; leave it empty for the whole workspace.",
    type: "Whether the template produces a task or a document, which decides the keys templateData may hold.",
    name: "The template name, stored trimmed; a name of only spaces is refused.",
    templateData:
      "The prefilled fields as a JSON object; a task template may hold task fields such as title and labels, a document template only title and body.",
  },
  user_settings: {
    user: "The user these settings belong to; it must be the signed-in user and cannot be changed.",
    theme: "The color scheme the app should use; system follows the device.",
    font: "The typeface family the app should use.",
    font_size: "The text size as a whole number from 12 to 24; 0 means unset.",
    default_view:
      "The saved view to open by default, which must be one the user can read; it is cleared if that view is deleted.",
    default_project:
      "The project to open by default, which must be one the user can read; it is cleared if that project is deleted.",
    time_zone:
      "An IANA time zone name such as Europe/Paris that sets the day for this user; empty means none, and Local is refused.",
  },
  users: {
    name: "The display name, stored trimmed; optional at signup, but changing it to an empty name is refused.",
    avatar: "A public profile picture of up to 5 MB; only the account owner can change it.",
    approved:
      "Whether an app administrator has approved the account, which signing in requires; a value sent by a user is refused.",
    email_key:
      "The normalised email address that stops duplicate accounts; the server computes it on every save, it is never shown, and a value sent is replaced.",
  },
  workspace_invitations: {
    workspace: "The workspace the invitation is for; required at create.",
    email:
      "The address to invite, stored trimmed and lowercased; no account needs to exist for it yet.",
    email_key:
      "The normalised address used to match the invitee; the server computes it, it is never shown, and a value sent is replaced.",
    role: "The role the invitee gets on accepting; an admin may invite only as member.",
    invited_by:
      "The user who sent the invitation; the server fills it from the caller, and a value sent is replaced.",
  },
  workspace_members: {
    workspace:
      "The workspace of this membership; set when an invitation is accepted and cannot be changed.",
    user: "The member; set when an invitation is accepted and cannot be changed.",
    role: "What the member may do: admin also manages configuration, member edits work, viewer only reads; only the workspace owner may change it.",
    status:
      "Whether the membership grants access: active does and suspended does not; the owner or an active admin may switch between the two, except on the row of the workspace owner.",
  },
  workspaces: {
    name: "The workspace name, for display only, stored trimmed; a name of only spaces is refused.",
    owner:
      "The user who owns the workspace; leave it empty and the server fills the caller, and it changes only through an ownership transfer.",
    priorities:
      "The priority list as a JSON array of objects with id and name, most severe first; an entry sent without an id gets one.",
    default_project:
      "The project members open first in this workspace, which must be a project of the same workspace.",
    trashed:
      "When the workspace was moved to the trash by DELETE; send it empty to restore the workspace, any other change is refused.",
  },
};

function apply(app, text_of) {
  for (const name of Object.keys(HELP)) {
    const c = app.findCollectionByNameOrId(name);
    for (const fname of Object.keys(HELP[name])) {
      const f = c.fields.getByName(fname);
      if (!f) throw new Error(name + "." + fname + ": no such field");
      f.help = text_of(HELP[name][fname]);
    }
    app.save(c);
  }
}

migrate(
  (app) => apply(app, (t) => t),
  (app) => apply(app, () => ""),
);
