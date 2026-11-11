# Contract

This change adds two key routes and two `api_keys` fields to the API, extends the
hosted-mcp-endpoint authorization server for one more pre-registered client, `tm`, and adds the
`tm` verbs `login` (browser), `login --with-key`, `logout`, `keys create`, `keys list` and
`keys revoke`. Rulings cited: the proposal's rulings 1 to 3 (2026-11-10) and the
decision record "Hosted MCP endpoint auth model" (kata `hfrk`), rulings 3, 4, 6 and 7. `{API}` is
the PocketBase server's public origin, as in the hosted-mcp-endpoint contract. A value marked
*(Q n)* follows this change's Open Question n, ruled by the owner on 2026-11-10 (design, Open
Questions).

## Routes

### API, `{API}`

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/tracker/keys` | The caller's keys, every one, newest first, no secret. |
| POST | `/api/tracker/keys/{id}/revoke` | Revokes one of the caller's keys. |
| GET | `/api/tracker/me` | Existing; under a key its `key` object gains `manage_keys`. |
| GET, POST | `/oauth/authorize` | Existing (hosted-mcp-endpoint); gains the `tm` client's parameters below. |
| POST | `/oauth/token` | Existing (hosted-mcp-endpoint); a `tm` grant answers as below. |

### Command line, `tm`

| Command | Purpose |
| --- | --- |
| `tm login [--url URL] [--scope LEVEL] [--no-browser] [--json]` | Signs in through the browser; saves the minted key. |
| `tm login --with-key [--url URL] [--json]` | Saves a pasted key (today's `tm login`). |
| `tm logout [--json]` | Revokes the saved key where it may, then removes the saved login. |
| `tm keys create --name NAME --scope LEVEL [--expires DATE] [--url URL] [--no-browser] [--json]` | Mints a key through the browser; prints it once; saves nothing. |
| `tm keys list [--all] [--json]` | Lists the user's keys. |
| `tm keys revoke <id> [--json]` | Revokes one key. |

key-scoping is built before this change: `LEVEL` is `read`, `write`, `manage` or `own`, as
key-scoping's contract defines them, and the consent page offers the level up to `LEVEL` and the
workspace choice (all workspaces, or one); `tm` has no workspace flag because the authorization
request carries none.

## Requests and Responses

### `api_keys` fields added

| Field | Type | Client may set | Meaning |
| --- | --- | --- | --- |
| `manage_keys` | bool | Superuser at create only; any other value sent at create is replaced with `false`; never on update | The key may list and revoke its user's keys (never mint). |
| `last_used` | date, `""` when never used | Never | When the key last authenticated a request, stored at full precision and written at most once a minute, so it can trail the latest use by up to 60 seconds. |

Both appear wherever an `api_keys` record is returned to its user's session.

### `GET /api/tracker/keys`

Caller: a user session; a key with reach `all` whose `manage_keys` is true; or any key whose reach is not `all`, for itself only. No query parameters, no body.
`200`:

```json
{
  "items": [
    {
      "id": "saeymergs6b807p",
      "name": "tm on build-host",
      "scope": "write",
      "client_id": "tm",
      "manage_keys": true,
      "created": "2026-11-10 22:13:28.369Z",
      "expires": "",
      "last_used": "2026-11-10 22:13:56.390Z",
      "revoked": false,
      "current": true,
      "reach": "all",
      "workspace": "",
      "projects": []
    }
  ]
}
```

| Field | Type | Value |
| --- | --- | --- |
| `id`, `name`, `scope`, `client_id`, `manage_keys`, `created`, `expires`, `last_used`, `revoked` | as stored | `expires` and `last_used` are `""` when empty; `client_id` is `""` for a hand-minted key |
| `current` | boolean | `true` only for the key that made this request; always `false` under a session |

Every key of the caller's user, revoked and expired ones included, sorted by `created`
descending then `id` ascending; under a key whose `reach` is not `all`, only that key itself,
whatever its `manage_keys` (root ruling 5). Never `key` or `key_hash`. Each item also carries key-scoping's `reach`, `workspace` and `projects`, as its contract
names them (built before this change).

### `POST /api/tracker/keys/{id}/revoke`

Caller as above. No body. Sets `revoked` to true on the caller's user's key `{id}`; a key already
revoked is left as it is. `200`, one item in the list item's shape, after the change. A key may
revoke itself; that request succeeds, and the key answers 401 from the next request on.

### `GET /api/tracker/me` under a key

The hosted-mcp-endpoint contract's `key` object gains one field:

```json
"key": { "id": "<record id>", "scope": "write", "expires": "", "client_id": "tm", "manage_keys": true }
```

### Authorization requests from the `tm` client

`tm` is a pre-registered public client (hfrk ruling 4; RFC 8252 §8.4):

| `client_id` | Name | Redirect URIs | Auth |
| --- | --- | --- | --- |
| `tm` | tm (command line) | `http://127.0.0.1/callback`, any port (RFC 8252 §7.3) | `none` |

`GET {API}/oauth/authorize` takes, beside the hosted-mcp-endpoint parameters:

| Parameter | Clients | Rule |
| --- | --- | --- |
| `scope` value `keys` | `tm` only | Asks for the manage-keys permission. From any other client: `invalid_scope`. |
| `key_name` | `tm` only | The minted key's name: 1 to 200 characters after trimming, else `invalid_request`. Absent: `tm`. Ignored from other clients (RFC 6749 §3.1: unrecognized parameters are ignored). |
| `key_expires` | `tm` only | The key's expiry: an RFC 3339 date-time in UTC (`2026-12-01T00:00:00Z`) later than now, else `invalid_request`. Absent: the key never expires *(Q1)*. Ignored from other clients. |

`keys` is not listed in `scopes_supported`, which stays as key-scoping sets it (`["read",
"write", "manage", "own"]`; RFC 8414 §2 lets a server leave a supported value unadvertised). The consent page, for the `tm` client, also shows
the key name and its expiry (`Expires: <YYYY-MM-DD HH:MM> UTC`, or `Expires: never` when absent) and, when `keys` was asked for, a
checkbox "Also let this key list and revoke your keys", ticked by default. Approving with it
unticked grants the scope without `keys`.

### Token response to a `tm` grant

`POST {API}/oauth/token` with `grant_type=authorization_code` and `client_id=tm`, `200`,
`Cache-Control: no-store`:

```json
{ "access_token": "tmk_<40 characters>", "token_type": "Bearer", "scope": "read write keys" }
```

- No `refresh_token`: a `tm` grant is never refreshed, and `grant_type=refresh_token` with
  `client_id=tm` answers 400 `invalid_grant`.
- `expires_in` is present, in whole seconds, only when `key_expires` was given.
- `scope` is the granted scope, `keys` last when granted.
- The minted record: `name` from `key_name`, `scope` from the granted level, `expires` from
  `key_expires` or `""`, `client_id` `tm`, `manage_keys` true exactly when `keys` was granted,
  and the hosted-mcp-endpoint's refresh-token fields empty.

### `tm` commands

Shared rules:

- **Server URL.** `--url`, else `TM_URL`, else the saved login's URL; trailing slashes removed.
  Only `login` and `keys create` read `--url`; other verbs ignore it, as today.
- **Credential.** `TM_API_KEY`, else the credential store entry of the saved login, when the
  configuration file exists and the server URL in use (`TM_URL`, else the saved URL) is the saved
  one, else the key in the configuration file; once the file is gone no store entry is read. Saving a key to one of the two clears the other (best effort): a key saved to the file
  removes the store entry for that URL whatever `TM_CREDENTIAL_STORE` says, and when, with the store
  in use (`os`), it cannot be reached to remove it, `tm` prints one warning line on standard error;
  a save that fails leaves the store as it was, so an older stored key never silently wins over a
  newer login. `keys list` and `keys revoke` need one; `login` and `keys create` do
  not. `logout` acts on the saved login only and ignores `TM_URL` and `TM_API_KEY`.
- **Configuration.** `$XDG_CONFIG_HOME/tm/config.json` (`~/.config/tm/config.json` when
  `XDG_CONFIG_HOME` is unset or not an absolute path), mode 0600, in a directory set to 0700 on every save. With a
  credential store it holds `{"url": "<url>"}`; without one, `{"url": "<url>", "key": "<key>"}`.
  The credential store entry is service `tm`, account `<url>`. `TM_CREDENTIAL_STORE=file` uses
  the file even where a store exists; any value other than `file` or `os` is refused. Under Node,
  which has no built-in store, the file is used *(Q2)*.
- **Browser.** `login` and `keys create` print the authorization URL on standard error, then open
  it with `open` (macOS), `xdg-open` (Linux) or `rundll32 url.dll,FileProtocolHandler`
  (Windows), unless `--no-browser`. They listen on `127.0.0.1` on a port the system picks, and
  wait at most 300 seconds for the callback.
- **Exit codes.** 0 done; 1 the server, the sign-in or the saved login refused; 2 usage; 130
  interrupted (Ctrl-C).
- **Output.** Human text on standard output, notes on standard error; `--json` prints exactly
  one JSON value on standard output. Errors print `tm: <message>` on standard error.

| Command | Human output (standard output) | `--json` |
| --- | --- | --- |
| `login` | `logged in to <url> as <user name>; key <id> saved in <the system credential store \| <config path>>` | `{"saved": "<config path>", "store": "os" \| "file", "url": "<url>", "user": {"id", "name"}, "key": {"id", "scope", "expires", "client_id", "manage_keys"}}` |
| `login --with-key` | `saved to <config path>`, plus ` (key in the system credential store)` when it went there | `{"saved": "<config path>", "store": "os" \| "file"}` |
| `logout` | `logged out of <url>; key <id> revoked`, or `logged out of <url>; key <id> was not revoked: <reason>` (reason `this key cannot revoke keys (reach all, no manage-keys permission)`, exit 0; or the server's message, exit 1), or `logged out of <url>; the saved key was already invalid` (exit 0; JSON `key_id` `""`, `revoked` false), or `logged out of <url>; the saved key was not revoked: <message>` when the server did not answer before the key's id was known (exit 1; JSON `key_id` `""`, `revoked` false). The saved login is removed in every case, and its credential store entry too where the store answers (whatever `TM_CREDENTIAL_STORE` says); when it does not, one `tm: warning:` line on standard error names the URL. | `{"url": "<url>", "key_id": "<id>" \| "", "revoked": true \| false}` |
| `keys create` | the `tmk_` secret alone, one line; on standard error `created key <id> "<name>" (<scope>, expires <YYYY-MM-DD HH:MM UTC \| never>); it is shown only this once` | `{"id", "name", "scope", "expires", "client_id": "tm", "manage_keys": false, "key": "tmk_..."}` |
| `keys list` | a table: `ID`, `NAME` (first 24 characters), `SCOPE`, `CLIENT` (first 24 characters; `-` for `""`), `CREATED`, `EXPIRES` (`never`), `LAST USED` (`never`), `STATUS` (`active`, `expired`, `revoked`; `active*` for the current key); dates as `YYYY-MM-DD HH:MM` UTC; `no keys` when empty. Active keys only unless `--all`. | the route's `items` array, filtered the same way |
| `keys revoke` | `revoked <id> "<name>"`; when the revoked key is the one the command used, also `tm: note: that was this login's key; run tm login again` on standard error | the route's item |

`--expires DATE` takes `YYYY-MM-DD` (00:00 UTC that day) or an RFC 3339 date-time with a zone,
and is sent as `key_expires` in UTC.

## Errors

### API

| Status | Code (`data.api_key.code`) | Message | When |
| --- | --- | --- | --- |
| 401 | none | PocketBase's "The request requires valid record authorization token." | No credential, on either key route |
| 403 | none | PocketBase's "The authorized record is not allowed to perform this action." | A superuser on either key route |
| 403 | `api_key_manage` | `This API key cannot list or revoke keys.` | A key with reach `all` whose `manage_keys` is false, on either key route |
| 404 | none | `No key with that id among yours.` | `revoke` naming an id that is not one of the caller's user's keys, or, under a key whose reach is not `all`, any id but its own |
| 401 | `api_key_invalid` | unchanged | Invalid, revoked or expired key (unchanged) |

A read-scoped key with `manage_keys` is not refused `api_key_scope` on the revoke route. A key's
create of an `api_keys` record stays 403 `api_key_path`, whatever its `manage_keys`.

### Authorization server, `tm` client

Redirect errors as in the hosted-mcp-endpoint contract, plus: `invalid_request` for a bad
`key_name` or `key_expires`; `invalid_scope` for `keys` from another client. Token endpoint:
`invalid_grant` for a refresh by `client_id=tm`.

### `tm` refusals

| Exit | Message after `tm: ` | When |
| --- | --- | --- |
| 2 | `login needs --url the first time` | No URL from `--url`, `TM_URL` or a saved login (also for `keys create`, as `keys create needs --url or a saved login`) |
| 2 | `--scope wants read, write, manage or own` | Bad `--scope` |
| 2 | `keys create needs --name` / `keys create needs --scope` | Missing flag |
| 2 | `--name wants 1 to 200 characters` | Empty or long name after trimming |
| 2 | `--expires wants YYYY-MM-DD or a date-time with a time zone` | Unparseable, or a date that does not exist (`2026-02-30`) |
| 2 | `--expires must be in the future` | Not later than now |
| 2 | `--with-key cannot be combined with --scope or --no-browser` | Mixed flags |
| 2 | `unknown keys verb "<x>"; one of create, list, revoke` | Bad sub-verb |
| 2 | `missing <create\|list\|revoke>` / `missing <id>` | Missing positional |
| 1 | `<url> does not offer browser sign-in; use tm login --with-key` | Metadata route answers 404 |
| 1 | `sign-in was denied in the browser` | Callback `error=access_denied` |
| 1 | `sign-in failed: <error_description or error>` | Any other callback or token error |
| 1 | `sign-in failed: the callback carried no code` | A callback with the right `state` and neither `code` nor `error` |
| 1 | `sign-in answered for another server; nothing was saved` | `iss` absent or different from the metadata `issuer` |
| 1 | `sign-in was not finished within 5 minutes` | No valid callback in 300 s |
| 1 | `this key cannot list or revoke keys; run tm login to get one that can` | 403 `api_key_manage` |
| 1 | `no saved login to log out of` | `logout` with no saved login |
| 1 | `the credential store refused: <message>` | The credential store failed for a reason other than being unavailable |
| 1 | `TM_CREDENTIAL_STORE must be os or file` | Any other value |
| 1 | the API's message | Any other API refusal (unchanged) |

## Auth

| Surface | Caller | Credential |
| --- | --- | --- |
| `GET /api/tracker/keys`, `POST /api/tracker/keys/{id}/revoke` | The key's user | A user session; a `tmk_` key with reach `all` and `manage_keys` true, of any level, for every key of its user; any key whose reach is not `all`, for itself only (another id answers 404) |
| `POST /api/collections/api_keys/records` | Unchanged | A session; never a key, `manage_keys` or not |
| `/oauth/authorize` with `client_id=tm` | A person in a browser | The page's own sign-in, as for every client |
| `/oauth/token` with `client_id=tm` | `tm` | Public: `client_id` and the PKCE verifier |
| `PATCH /api/collections/api_keys/records/{id}` | Unchanged | A body naming `manage_keys` or `last_used` answers 404 to the owner (rule), and one changing either value answers 400 `manage_keys and last_used are set only at create or by the server.` to a superuser |

The manage-keys permission partly supersedes decision:api-key-reads-refused: a key with reach
`all` that carries it reads its user's key records through `GET /api/tracker/keys`; a key limited
to part of the tracker reads only its own record there (root ruling 5). Every other key path stays refused,
including a manage-keys key naming `api_keys` in a query string or realtime subscription.

## Compatibility

- **`tm login`** now opens a browser. A script that piped a key into `tm login` must add
  `--with-key`; without it, `tm` waits for a browser sign-in and exits 1 after 300 seconds. The
  `--json` answer of `tm login --with-key` keeps `saved` and adds `store`.
- **Saved logins.** A configuration file written before this change (`{url, key}`) keeps working:
  its key is read from the file. The next `tm login` moves the key into the credential store and
  rewrites the file to `{url}`.
- **Replacing a login.** `tm login` and `tm login --with-key` revoke the key they replace when it
  carries `manage_keys`; a pasted key is never revoked by `tm`.
- **`api_keys`.** Gains `manage_keys` and `last_used`; existing keys read `false` and `""`. The
  update rule refuses either field. Both carry their `app_docs` record and the `schema/`,
  `openapi.json` and model regenerations.
- **Other OAuth clients.** Unchanged: `keys`, `key_name` and `key_expires` are refused or ignored
  for them as stated above, and their grants keep the hosted-mcp-endpoint lifetime and refresh.
- **`GET /api/tracker/me`.** Gains `key.manage_keys`; nothing removed.
- **Every other `tm` verb.** Unchanged, apart from reading the key from the credential store.
