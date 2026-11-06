/// <reference path="../pb_data/types.d.ts" />
// GET project_items list: refuse a filter clause its field cannot answer and clamp paging, before PocketBase runs the query.

// Middleware, not onRecordsListRequest: that hook fires after the query has already run.
routerUse((e) => {
  const m = /^\/api\/collections\/([^/]+)\/records\/?$/.exec(
    e.request.url.path,
  );
  if (e.request.method !== "GET" || !m) return e.next();
  let col = null;
  try {
    col = e.app.findCollectionByNameOrId(m[1]);
  } catch (_) {
    return e.next();
  }
  if (col.name !== "project_items") return e.next();

  const q = e.request.url.query();
  const whole = (raw, fallback, max) => {
    const n = raw === "" ? NaN : Math.trunc(Number(raw));
    return isFinite(n) ? Math.min(Math.max(n, 1), max) : fallback;
  };
  q.set("page", String(whole(q.get("page"), 1, Number.MAX_SAFE_INTEGER)));
  q.set("perPage", String(whole(q.get("perPage"), 25, 200)));
  e.request.url.rawQuery = q.encode();

  // field -> [operators, blank allowed with = and !=, the value it takes]; a ? prefix (any-of) is the same test on a flat column.
  const FIELDS = {
    type: [["=", "!="], false, "task, document, decision or milestone"],
    status: [
      ["=", "!="],
      true,
      'a status id from the statuses collection, or "" for none',
    ],
    priority: [
      ["=", "!="],
      true,
      'a priority id from the workspace priorities, or "" for none',
    ],
    assignee: [["=", "!="], true, 'a user id, or "" for unassigned'],
    labels: [
      ["~", "!~", "=", "!="],
      true,
      'a label id from the labels collection with ~ and !~, or "[]" for no labels with = and !=',
    ],
    due: [
      ["=", "!=", "<", "<=", ">", ">=", "~", "!~"],
      true,
      'a date, or "" for no due date with = and !=',
    ],
  };
  const INTERSECTED = ["type", "status", "priority", "assignee"];
  const MIRROR = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };
  const refuse = (field, code, message) => {
    const data = {};
    data[field] = new ValidationError(code, message);
    throw new BadRequestError("The item-list filter cannot be answered.", data);
  };

  const filter = q.get("filter");
  // Past the list API's own 3500-character ceiling PocketBase refuses the filter itself.
  if (!filter || filter.length > 3500) return e.next();

  // Tokens per PocketBase's filter lexer; anything this cannot read is left for PocketBase to refuse.
  const OPS = [
    "?!=",
    "?!~",
    "?>=",
    "?<=",
    "!=",
    "!~",
    ">=",
    "<=",
    "?=",
    "?~",
    "?>",
    "?<",
    "=",
    "~",
    ">",
    "<",
  ];
  const toks = [];
  let i = 0;
  while (i < filter.length) {
    const c = filter[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && filter[i + 1] === "/") {
      while (i < filter.length && filter[i] !== "\n") i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let v = "";
      while (j < filter.length && filter[j] !== c) {
        if (filter[j] === "\\" && j + 1 < filter.length) j++;
        v += filter[j++];
      }
      if (j >= filter.length) return e.next();
      toks.push({ k: "lit", v: v, quoted: true });
      i = j + 1;
    } else if (c === "(" || c === ")") {
      toks.push({ k: c });
      i++;
    } else if (filter.startsWith("&&", i) || filter.startsWith("||", i)) {
      toks.push({ k: filter.substr(i, 2) });
      i += 2;
    } else {
      const op = OPS.find((o) => filter.startsWith(o, i));
      if (op) {
        toks.push({ k: "op", v: op });
        i += op.length;
        continue;
      }
      let j = i;
      while (j < filter.length && !/[\s()"'=!<>~?&|]/.test(filter[j])) j++;
      if (j === i) return e.next();
      const w = filter.slice(i, j);
      const ident =
        /^[A-Za-z_]/.test(w) && ["true", "false", "null"].indexOf(w) === -1;
      toks.push(
        ident ? { k: "id", v: w } : { k: "lit", v: w === "null" ? "" : w },
      );
      i = j;
    }
  }

  // expr := and ('||' and)* ; and := atom ('&&' atom)* ; atom := '(' expr ')' | operand op operand
  let p = 0;
  const operand = () => {
    const t = toks[p];
    if (!t || (t.k !== "id" && t.k !== "lit")) throw "unparsed";
    p++;
    if (t.k !== "id" || !toks[p] || toks[p].k !== "(") return t;
    // A function call such as strftime(...) is an operand that names no column of its own.
    for (let depth = 0; p < toks.length; p++) {
      if (toks[p].k === "(") depth++;
      else if (toks[p].k === ")" && --depth === 0) break;
    }
    if (p >= toks.length) throw "unparsed";
    p++;
    return { k: "call" };
  };
  const atom = () => {
    if (toks[p] && toks[p].k === "(") {
      p++;
      const inner = expr();
      if (!toks[p] || toks[p].k !== ")") throw "unparsed";
      p++;
      return inner;
    }
    const a = operand();
    const o = toks[p];
    if (!o || o.k !== "op") throw "unparsed";
    p++;
    const b = operand();
    return { cmp: true, a: a, op: o.v, b: b };
  };
  const chain = (sep, next) => {
    const parts = [next()];
    while (toks[p] && toks[p].k === sep) {
      p++;
      parts.push(next());
    }
    return parts.length === 1 ? parts[0] : { join: sep, parts: parts };
  };
  const and = () => chain("&&", atom);
  const expr = () => chain("||", and);
  let tree = null;
  try {
    tree = expr();
    if (p !== toks.length) return e.next();
  } catch (_) {
    return e.next();
  }

  // Each comparison as {field, op, value} on a governed field, field side normalised to the left.
  const governed = (c) => {
    let f = c.a;
    let v = c.b;
    let op = c.op.replace(/^\?/, "");
    if (f.k !== "id" && v.k === "id") {
      f = c.b;
      v = c.a;
      op = MIRROR[op] || op;
    }
    if (f.k !== "id") return null;
    const root = f.v.split(/[.:]/)[0];
    if (f.v !== root) {
      if (f.v.indexOf(".") !== -1)
        refuse(
          root,
          "not_expressible",
          root +
            " is a flat column here and cannot follow a relation; filter it by " +
            (FIELDS[root] ? FIELDS[root][2] : "its id"),
        );
      if (FIELDS[root])
        refuse(
          root,
          "operator_not_supported",
          root +
            " filters accept " +
            FIELDS[root][0].join(" ") +
            " with no modifier",
        );
      return null;
    }
    if (!FIELDS[root]) return null;
    const spec = FIELDS[root];
    if (spec[0].indexOf(op) === -1)
      refuse(
        root,
        "operator_not_supported",
        root + " filters accept " + spec[0].join(" ") + " with " + spec[2],
      );
    const blank = v.k === "lit" && v.v === "";
    if (blank && !(spec[1] && (op === "=" || op === "!=")))
      refuse(root, "value_required", root + " filters need " + spec[2]);
    // Only a quoted value is comparable as text; a macro such as @request.auth.id is not.
    return { field: root, op: op, value: v.quoted ? v.v : null };
  };
  const walk = (n) => {
    if (n.cmp) n.g = governed(n);
    else n.parts.forEach(walk);
  };
  walk(tree);

  // Equality sets of the top-level conjunction: one `field = v`, or a group of them joined by ||.
  const conj = tree.join === "&&" ? tree.parts : [tree];
  const sets = {};
  conj.forEach((n) => {
    const leaves = n.cmp ? [n] : n.join === "||" ? n.parts : [];
    if (
      !leaves.length ||
      !leaves.every((l) => l.cmp && l.g && l.g.op === "=" && l.g.value !== null)
    )
      return;
    const field = leaves[0].g.field;
    if (
      INTERSECTED.indexOf(field) === -1 ||
      !leaves.every((l) => l.g.field === field)
    )
      return;
    const vals = leaves.map((l) => l.g.value);
    sets[field] = sets[field]
      ? sets[field].filter((v) => vals.indexOf(v) !== -1)
      : vals;
    if (!sets[field].length)
      refuse(
        field,
        "values_conflict",
        "the " + field + " clauses of this filter cannot all hold at once",
      );
  });
  return e.next();
});
