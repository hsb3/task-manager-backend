/// <reference path="../pb_data/types.d.ts" />
// decisions/documents/milestones/tasks/comments: write-side field guards — author is stamped at create then immutable, and Publish is one-way.

// Pooled JSVM: each callback runs in an isolated runtime and CANNOT reach a shared
// top-level helper — each block below is inlined byte-identically per collection on purpose.
// KEEP IN SYNC: author-capture block (decisions / documents / milestones / tasks / comments).

onRecordCreateRequest((e) => {
  // Overwrites any submitted author, so a member cannot file a record under someone
  // else's name; a superuser create keeps what it submitted (seed/import fidelity).
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  if (actor) e.record.set("author", actor);
  e.next();
}, "decisions");

onRecordCreateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  if (actor) e.record.set("author", actor);
  e.next();
}, "documents");

onRecordCreateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  if (actor) e.record.set("author", actor);
  e.next();
}, "milestones");

onRecordCreateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  if (actor) e.record.set("author", actor);
  e.next();
}, "tasks");

onRecordCreateRequest((e) => {
  const actor = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  if (actor) e.record.set("author", actor);
  e.next();
}, "comments");

// TASK-031: author is immutable after create — rules can't see the old record,
// so this compares against a re-fetched original (scope.pb.js D4 idiom).
// KEEP IN SYNC: author-immutability block (decisions / documents / milestones / tasks / comments).
onRecordUpdateRequest((e) => {
  const orig = e.app.findRecordById("decisions", e.record.id);
  if (orig.get("author") !== e.record.get("author")) {
    throw new BadRequestError("author is immutable");
  }
  e.next();
}, "decisions");

onRecordUpdateRequest((e) => {
  const orig = e.app.findRecordById("documents", e.record.id);
  if (orig.get("author") !== e.record.get("author")) {
    throw new BadRequestError("author is immutable");
  }
  e.next();
}, "documents");

onRecordUpdateRequest((e) => {
  const orig = e.app.findRecordById("milestones", e.record.id);
  if (orig.get("author") !== e.record.get("author")) {
    throw new BadRequestError("author is immutable");
  }
  e.next();
}, "milestones");

onRecordUpdateRequest((e) => {
  const orig = e.app.findRecordById("tasks", e.record.id);
  if (orig.get("author") !== e.record.get("author")) {
    throw new BadRequestError("author is immutable");
  }
  e.next();
}, "tasks");

onRecordUpdateRequest((e) => {
  const orig = e.app.findRecordById("comments", e.record.id);
  if (orig.get("author") !== e.record.get("author")) {
    throw new BadRequestError("author is immutable");
  }
  e.next();
}, "comments");

// decision:draft-private-publish-one-way: Publish is one-way — publishing already sent mention notifications that
// nothing can retract, so going back would leave a member holding an invisible notification
// row for an item they can no longer open. Withdrawal is Trash.
// KEEP IN SYNC: publish-one-way block (decisions / documents / milestones).
onRecordUpdateRequest((e) => {
  // decision:draft-private-publish-one-way refuses this direction for every authenticated caller, including one writing
  // straight at the collection endpoint, and exempts only a superuser: seeding and import are
  // superuser writes, and blocking them would block the fixtures that prove the rest.
  const su = e.auth && e.auth.isSuperuser();
  // requestInfo().body is already cast ("yes" reads false), so draft is read raw: a JSON body, or a
  // form whose @jsonPayload (every batch sub-request) holds JSON and whose draft field holds text.
  const rq = e.requestEvent.request;
  const sent = [];
  const fromJson = (text) => {
    try {
      const b = JSON.parse(text);
      if (b && typeof b === "object" && "draft" in b) sent.push(b.draft);
    } catch (_) {}
  };
  if (String(rq.header.get("content-type")).indexOf("json") >= 0) {
    fromJson(toString(rq.body));
  } else {
    // Every repeat of a field, not only the first: PocketBase applies the later ones too, and
    // url.Values offers only its first value to the JSVM, so the form is read back encoded.
    rq.postForm
      .encode()
      .split("&")
      .forEach((pair) => {
        const at = pair.indexOf("=");
        if (at < 0) return;
        const dec = (x) => decodeURIComponent(x.replace(/\+/g, " "));
        const key = dec(pair.slice(0, at));
        const val = dec(pair.slice(at + 1));
        if (key === "@jsonPayload") fromJson(val);
        else if (key === "draft")
          sent.push(val === "true" ? true : val === "false" ? false : val);
      });
  }
  if (sent.some((v) => v !== true && v !== false)) {
    throw new BadRequestError("draft must be true or false");
  }
  if (
    !su &&
    (sent.indexOf(true) !== -1 ||
      (!e.record.original().getBool("draft") && e.record.getBool("draft")))
  ) {
    throw new BadRequestError(
      "A published item cannot be returned to draft. Move it to trash instead.",
    );
  }
  e.next();
}, "decisions");

onRecordUpdateRequest((e) => {
  // decision:draft-private-publish-one-way refuses this direction for every authenticated caller, including one writing
  // straight at the collection endpoint, and exempts only a superuser: seeding and import are
  // superuser writes, and blocking them would block the fixtures that prove the rest.
  const su = e.auth && e.auth.isSuperuser();
  // requestInfo().body is already cast ("yes" reads false), so draft is read raw: a JSON body, or a
  // form whose @jsonPayload (every batch sub-request) holds JSON and whose draft field holds text.
  const rq = e.requestEvent.request;
  const sent = [];
  const fromJson = (text) => {
    try {
      const b = JSON.parse(text);
      if (b && typeof b === "object" && "draft" in b) sent.push(b.draft);
    } catch (_) {}
  };
  if (String(rq.header.get("content-type")).indexOf("json") >= 0) {
    fromJson(toString(rq.body));
  } else {
    // Every repeat of a field, not only the first: PocketBase applies the later ones too, and
    // url.Values offers only its first value to the JSVM, so the form is read back encoded.
    rq.postForm
      .encode()
      .split("&")
      .forEach((pair) => {
        const at = pair.indexOf("=");
        if (at < 0) return;
        const dec = (x) => decodeURIComponent(x.replace(/\+/g, " "));
        const key = dec(pair.slice(0, at));
        const val = dec(pair.slice(at + 1));
        if (key === "@jsonPayload") fromJson(val);
        else if (key === "draft")
          sent.push(val === "true" ? true : val === "false" ? false : val);
      });
  }
  if (sent.some((v) => v !== true && v !== false)) {
    throw new BadRequestError("draft must be true or false");
  }
  if (
    !su &&
    (sent.indexOf(true) !== -1 ||
      (!e.record.original().getBool("draft") && e.record.getBool("draft")))
  ) {
    throw new BadRequestError(
      "A published item cannot be returned to draft. Move it to trash instead.",
    );
  }
  e.next();
}, "documents");

onRecordUpdateRequest((e) => {
  // decision:draft-private-publish-one-way refuses this direction for every authenticated caller, including one writing
  // straight at the collection endpoint, and exempts only a superuser: seeding and import are
  // superuser writes, and blocking them would block the fixtures that prove the rest.
  const su = e.auth && e.auth.isSuperuser();
  // requestInfo().body is already cast ("yes" reads false), so draft is read raw: a JSON body, or a
  // form whose @jsonPayload (every batch sub-request) holds JSON and whose draft field holds text.
  const rq = e.requestEvent.request;
  const sent = [];
  const fromJson = (text) => {
    try {
      const b = JSON.parse(text);
      if (b && typeof b === "object" && "draft" in b) sent.push(b.draft);
    } catch (_) {}
  };
  if (String(rq.header.get("content-type")).indexOf("json") >= 0) {
    fromJson(toString(rq.body));
  } else {
    // Every repeat of a field, not only the first: PocketBase applies the later ones too, and
    // url.Values offers only its first value to the JSVM, so the form is read back encoded.
    rq.postForm
      .encode()
      .split("&")
      .forEach((pair) => {
        const at = pair.indexOf("=");
        if (at < 0) return;
        const dec = (x) => decodeURIComponent(x.replace(/\+/g, " "));
        const key = dec(pair.slice(0, at));
        const val = dec(pair.slice(at + 1));
        if (key === "@jsonPayload") fromJson(val);
        else if (key === "draft")
          sent.push(val === "true" ? true : val === "false" ? false : val);
      });
  }
  if (sent.some((v) => v !== true && v !== false)) {
    throw new BadRequestError("draft must be true or false");
  }
  if (
    !su &&
    (sent.indexOf(true) !== -1 ||
      (!e.record.original().getBool("draft") && e.record.getBool("draft")))
  ) {
    throw new BadRequestError(
      "A published item cannot be returned to draft. Move it to trash instead.",
    );
  }
  e.next();
}, "milestones");

// draft is a boolean on create: PocketBase would cast "yes" to false and publish; refuse it.
// KEEP IN SYNC: draft-type create block (decisions / documents / milestones); the update blocks above read the value the same way.
onRecordCreateRequest((e) => {
  // requestInfo().body is already cast ("yes" reads false), so draft is read raw: a JSON body, or a
  // form whose @jsonPayload (every batch sub-request) holds JSON and whose draft field holds text.
  const rq = e.requestEvent.request;
  const sent = [];
  const fromJson = (text) => {
    try {
      const b = JSON.parse(text);
      if (b && typeof b === "object" && "draft" in b) sent.push(b.draft);
    } catch (_) {}
  };
  if (String(rq.header.get("content-type")).indexOf("json") >= 0) {
    fromJson(toString(rq.body));
  } else {
    // Every repeat of a field, not only the first: PocketBase applies the later ones too, and
    // url.Values offers only its first value to the JSVM, so the form is read back encoded.
    rq.postForm
      .encode()
      .split("&")
      .forEach((pair) => {
        const at = pair.indexOf("=");
        if (at < 0) return;
        const dec = (x) => decodeURIComponent(x.replace(/\+/g, " "));
        const key = dec(pair.slice(0, at));
        const val = dec(pair.slice(at + 1));
        if (key === "@jsonPayload") fromJson(val);
        else if (key === "draft")
          sent.push(val === "true" ? true : val === "false" ? false : val);
      });
  }
  if (sent.some((v) => v !== true && v !== false)) {
    throw new BadRequestError("draft must be true or false");
  }
  e.next();
}, "decisions");

onRecordCreateRequest((e) => {
  // requestInfo().body is already cast ("yes" reads false), so draft is read raw: a JSON body, or a
  // form whose @jsonPayload (every batch sub-request) holds JSON and whose draft field holds text.
  const rq = e.requestEvent.request;
  const sent = [];
  const fromJson = (text) => {
    try {
      const b = JSON.parse(text);
      if (b && typeof b === "object" && "draft" in b) sent.push(b.draft);
    } catch (_) {}
  };
  if (String(rq.header.get("content-type")).indexOf("json") >= 0) {
    fromJson(toString(rq.body));
  } else {
    // Every repeat of a field, not only the first: PocketBase applies the later ones too, and
    // url.Values offers only its first value to the JSVM, so the form is read back encoded.
    rq.postForm
      .encode()
      .split("&")
      .forEach((pair) => {
        const at = pair.indexOf("=");
        if (at < 0) return;
        const dec = (x) => decodeURIComponent(x.replace(/\+/g, " "));
        const key = dec(pair.slice(0, at));
        const val = dec(pair.slice(at + 1));
        if (key === "@jsonPayload") fromJson(val);
        else if (key === "draft")
          sent.push(val === "true" ? true : val === "false" ? false : val);
      });
  }
  if (sent.some((v) => v !== true && v !== false)) {
    throw new BadRequestError("draft must be true or false");
  }
  e.next();
}, "documents");

onRecordCreateRequest((e) => {
  // requestInfo().body is already cast ("yes" reads false), so draft is read raw: a JSON body, or a
  // form whose @jsonPayload (every batch sub-request) holds JSON and whose draft field holds text.
  const rq = e.requestEvent.request;
  const sent = [];
  const fromJson = (text) => {
    try {
      const b = JSON.parse(text);
      if (b && typeof b === "object" && "draft" in b) sent.push(b.draft);
    } catch (_) {}
  };
  if (String(rq.header.get("content-type")).indexOf("json") >= 0) {
    fromJson(toString(rq.body));
  } else {
    // Every repeat of a field, not only the first: PocketBase applies the later ones too, and
    // url.Values offers only its first value to the JSVM, so the form is read back encoded.
    rq.postForm
      .encode()
      .split("&")
      .forEach((pair) => {
        const at = pair.indexOf("=");
        if (at < 0) return;
        const dec = (x) => decodeURIComponent(x.replace(/\+/g, " "));
        const key = dec(pair.slice(0, at));
        const val = dec(pair.slice(at + 1));
        if (key === "@jsonPayload") fromJson(val);
        else if (key === "draft")
          sent.push(val === "true" ? true : val === "false" ? false : val);
      });
  }
  if (sent.some((v) => v !== true && v !== false)) {
    throw new BadRequestError("draft must be true or false");
  }
  e.next();
}, "milestones");
