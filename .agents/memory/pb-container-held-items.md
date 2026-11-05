---
name: pb-container-held-items
description: "An item submitted without a project lands in its workspace's hidden shadow project (decision-052), whose projects rules end in shadow = false, so expand=project comes back EMPTY on an item that has one"
metadata:
  type: project
---

`landInShadowProject` (`pb_hooks/shadow.pb.js`) runs on the universal create AND update tiers for
tasks, decisions, documents and milestones, and puts an item submitted without a project into that
workspace's hidden container project. A create naming a parent but no project inherits the
parent's project first (`pb_hooks/main.pb.js`, request tier), so a subtask stays with its parent.

`project` stays optional in the schema (required only on milestones), so a project-less item now
exists only two ways: a raw-SQL write, which bypasses every hook, or a failed container save,
which is LOGGED rather than refused and self-heals on the item's next save.

The live trap is the opposite one: `task.project.workspace` RESOLVES for a container-held item,
but every `projects` list/view rule ends in `shadow = false` (`schema/projects.rules.json`), so the
caller's `expand=project` is empty.

**How to apply:** when touching anything keyed on `task.project.*`, ask what a container-held
item does; a project-less one is the anomaly. PocketBase omits records the caller cannot view from `expand` (see the pocketbase plugin's field notes).
