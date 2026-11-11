## Purpose

How an operator signs `tm` in, mints, lists and revokes API keys from the command line without
the dashboard or hand-written HTTP, and what the server offers a key that may manage keys.

## ADDED Requirements

### Requirement: tm login signs in through the browser and saves a minted key

`tm login` SHALL sign in through the tracker's own authorization server as the pre-registered
public client `tm`, with a loopback redirect on a port chosen at request time and PKCE, and SHALL
save the key the grant mints together with the server URL. It SHALL refuse an authorization
response whose `state` or `iss` does not match its request. It SHALL store no refresh token.

#### Scenario: A person approves in the browser

- **WHEN** an approved user runs `tm login --url <server>` and approves on the consent page
- **THEN** `tm` exits 0, the next `tm list` works without `TM_API_KEY`, and the user's key list shows a key named `tm on <hostname>` whose client is `tm`

#### Scenario: The person denies

- **WHEN** the person chooses Deny on the consent page
- **THEN** `tm login` exits 1, saves nothing, and leaves any earlier saved login in place

#### Scenario: A forged callback

- **WHEN** a request reaches the loopback listener with a `state` other than the one `tm` sent
- **THEN** the listener answers 400 and `tm` keeps waiting for the real callback

### Requirement: A pasted key remains a way to log in

`tm login --with-key` SHALL read a key from a terminal without echo, or from standard input when
it is not a terminal, refuse a value that does not start with `tmk_`, and save it as a login.

#### Scenario: A key piped in

- **WHEN** a `tmk_` key is piped into `tm login --with-key --url <server>`
- **THEN** `tm` exits 0 and later verbs use that key

### Requirement: The saved key lives in the operating system's credential store

`tm` SHALL keep the saved key in the operating system's credential store when one is available,
and otherwise in its configuration file, readable and writable only by the user, in a directory
only the user can open. `TM_URL` and `TM_API_KEY` SHALL keep overriding the saved login.

#### Scenario: No credential store

- **WHEN** `tm login --with-key` runs where no credential store is available
- **THEN** the key is written to the configuration file with mode 0600, its directory has mode 0700, and `tm` says on standard error where the key was saved

#### Scenario: A configuration directory left open

- **WHEN** the configuration directory exists with mode 0755 and `tm login --with-key` runs
- **THEN** the directory's mode is 0700 afterwards

### Requirement: The login key may manage keys and never mint

The key `tm login` saves SHALL carry a manage-keys permission when the person grants it on the
consent page. A key with reach all and that permission SHALL list the user's keys and revoke any
of them, whatever its level, and SHALL never create a key. A key with reach all and without it
SHALL be refused both. A key
limited to part of the tracker SHALL list and revoke only itself, whatever its permission. A permission sent by a client when creating a key SHALL be ignored, except from a superuser.

#### Scenario: A manage-keys key lists keys

- **WHEN** a key carrying the permission calls the key list
- **THEN** it receives every key of its user, without any secret, its own marked as current

#### Scenario: A key limited to one workspace

- **WHEN** a key limited to one workspace calls the key list, or revokes another key of its user
- **THEN** the list holds only that key, and the revoke answers 404

#### Scenario: A key without the permission

- **WHEN** a key with reach all and without the permission calls the key list or the revoke route
- **THEN** the server answers 403 `api_key_manage`

#### Scenario: A manage-keys key tries to mint

- **WHEN** a key carrying the permission creates an `api_keys` record
- **THEN** the server answers 403 `api_key_path`, as for every key

### Requirement: tm keys create mints a key through browser consent

`tm keys create` SHALL mint a key for another agent or script through the same browser sign-in
and consent, with the name, scope and optional expiry given on the command line, print its secret
once, and not save it. The key SHALL carry no manage-keys permission and no refresh token.

#### Scenario: A key for an agent

- **WHEN** an operator runs `tm keys create --name "ci bot" --scope read` and approves
- **THEN** standard output is the `tmk_` secret alone, the saved login is unchanged, and the key list shows `ci bot` with scope `read`

#### Scenario: An expiry in the past

- **WHEN** `tm keys create --name x --scope read --expires 2020-01-01` runs
- **THEN** `tm` exits 2 before opening any browser

### Requirement: tm keys list and tm keys revoke

`tm keys list` SHALL show the user's active keys (all of them with `--all`): id, name, scope,
client, created, expiry, last use and status, and never a secret. `tm keys revoke <id>` SHALL
revoke one key; revocation SHALL stay one-way and revoking a revoked key SHALL succeed unchanged.

#### Scenario: Revoking an agent's key

- **WHEN** the operator revokes a key by id and the agent holding it then calls the API
- **THEN** the agent's call answers 401 `api_key_invalid`

#### Scenario: An id that is not the user's

- **WHEN** `tm keys revoke` names an id that is not one of the user's keys
- **THEN** `tm` exits 1 and the server answered 404

### Requirement: tm logout ends the saved login

`tm logout` SHALL revoke the saved key when it carries the manage-keys permission and SHALL then
remove the saved login, key and URL alike. When the key cannot be revoked it SHALL still remove
the saved login and say why the key was left.

#### Scenario: Logging out

- **WHEN** a user logged in with `tm login` runs `tm logout`
- **THEN** the saved key answers 401 afterwards and `tm list` asks for `tm login`

### Requirement: A key records when it was last used

The server SHALL record on each key when it last authenticated a request, writing it at most once a minute, and
SHALL show it in the key list. No client SHALL set it.

#### Scenario: A key in use

- **WHEN** a key makes a request and the key list is read a moment later
- **THEN** that key's last use is within a minute of the request

### Requirement: Every key verb answers in JSON

`tm login`, `tm logout` and each `tm keys` verb SHALL print machine-readable JSON with `--json`,
and SHALL exit 0 on success, 1 when the server or the sign-in refused, 2 on a usage error and 130
when interrupted.

#### Scenario: Listing keys as JSON

- **WHEN** `tm keys list --json` runs
- **THEN** standard output is a JSON array of key objects
