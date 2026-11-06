/** Help text for view collection columns; a view rebuilds its fields from its query on every boot, so a migration cannot carry them and gen_openapi reads this instead. */
export const VIEW_FIELD_HELP: Record<string, Record<string, string>> = {
  project_items: {
    type: "Which kind of item the row is: task, decision, document or milestone; filter on it with = or != to list one kind.",
    title: "The title of the item, or the name when the item is a milestone.",
    key: "The display key of the item such as ENG-42, empty for an item kept at the workspace level.",
    project: "The id of the project the item sits in.",
    workspace: "The id of the workspace the item belongs to.",
    created: "When the underlying item was created; read-only.",
    updated: "When the underlying item was last changed; read-only.",
    trashed:
      "When the item was moved to the trash, or empty while it is live; a listing shows only live items.",
    draft:
      "True while the decision, document or milestone is an unpublished draft; always false for a task.",
    author:
      "The id of the user who created the item, empty when a superuser or the server created it.",
    assignee:
      "The id of the user a task is assigned to; empty when unassigned and on every other kind of item.",
    ordinal: "The place of a task in its board column, and 0 for every other kind of item.",
    due: "The due day of a task or the target day of a milestone, empty when there is none; filter on it with date comparisons.",
    has_due:
      "1 when the item has a due or target day and 0 when not; sort on it before due to keep dateless rows last in both directions.",
    priority_rank:
      "The place of the task priority in the workspace priority list, 0 for the most severe; a row without a priority holds a placeholder that ranks nothing.",
    has_priority:
      "1 when the task holds a priority from the current workspace list and 0 otherwise; sort on it before priority_rank to keep rows without a priority last.",
    status:
      "The status id of a task, the free-text status of a decision, and empty for a document or milestone.",
    priority:
      "The priority entry id of a task, empty when it has none and on every other kind of item.",
    parent: "The id of the parent task of a subtask, empty otherwise.",
    milestone: "The id of the milestone a task counts toward, empty otherwise.",
    labels:
      "The label ids of a task as one text value; filter with ~ and a label id, or with = [] for no labels.",
    dependencies:
      "The ids of the tasks blocking a task as one text value, filtered with ~ and a task id; empty on other kinds of item.",
    cycle:
      "The id of the cycle a task is planned in, empty otherwise; filter on it to list the tasks of one cycle.",
    project_trashed:
      "1 when the project of the item is in the trash or no longer exists, and 0 for a live project or no project.",
    workspace_trashed: "1 when the workspace of the item is in the trash and 0 otherwise.",
    workspace_owner: "The id of the user who owns the workspace of the item.",
    active_members:
      "The ids of the active members of the workspace, each wrapped in commas, so a match on one id never hits part of another.",
    active_admins:
      "The ids of the active admins of the workspace, each wrapped in commas, so a match on one id never hits part of another.",
    comment_count:
      "How many comments the task, document or decision has; 0 for a milestone and for an item in the trash.",
    status_terminal:
      "True when a task sits in a completed or canceled status of its own workspace; false for every other row.",
    status_off_pipeline:
      "True when a task sits in a canceled status of its own workspace; false for every other row.",
    open: "True when a task has a status of its own workspace that is not completed or canceled; false for an empty or unknown status and for other kinds of item.",
  },
  project_stats: {
    name: "The name of the project.",
    owner: "The id of the user who created the project, for display only.",
    workspace: "The id of the workspace the project belongs to.",
    total: "How many tasks outside the trash the project holds, including tasks with no status.",
    triage: "How many tasks outside the trash in the project have a status in the triage category.",
    backlog:
      "How many tasks outside the trash in the project have a status in the backlog category.",
    unstarted:
      "How many tasks outside the trash in the project have a status in the unstarted category.",
    started:
      "How many tasks outside the trash in the project have a status in the started category.",
    completed:
      "How many tasks outside the trash in the project have a status in the completed category.",
    canceled:
      "How many tasks outside the trash in the project have a status in the canceled category.",
  },
};
