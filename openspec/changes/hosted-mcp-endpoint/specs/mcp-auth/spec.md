## Purpose

How a remote MCP client obtains and presents a credential: an API key as a bearer token, or an
OAuth grant from the tracker's own authorization server that mints such a key.

## ADDED Requirements

### Requirement: One credential kind, the API key, presented as a bearer token

The MCP endpoint SHALL accept a `tmk_` API key in `Authorization: Bearer`, whether the key was
minted by hand or by an OAuth grant, and SHALL refuse with 401 every other token, including a
PocketBase user token.

#### Scenario: A hand-minted key

- **WHEN** a client configured with a hand-minted write key calls `tm_create`
- **THEN** the item is created as the key's user

#### Scenario: A user session token

- **WHEN** a client presents a PocketBase user token to the MCP endpoint
- **THEN** the endpoint answers 401 with `error="invalid_token"`

### Requirement: Discovery documents

The MCP service SHALL publish OAuth 2.0 Protected Resource Metadata (RFC 9728) for the endpoint,
naming the tracker's API origin as its only authorization server. The API SHALL publish OAuth 2.0
Authorization Server Metadata (RFC 8414) whose `issuer` is the API origin, advertising the
authorization code grant with PKCE `S256`, the refresh token grant, public clients, and Client ID
Metadata Documents, and no registration endpoint.

#### Scenario: A client follows the 401 challenge

- **WHEN** a client reads `resource_metadata` from a 401 and fetches it
- **THEN** it receives a document whose `resource` is the endpoint URL and whose `authorization_servers` names the API origin

#### Scenario: A client reads the authorization server metadata

- **WHEN** a client fetches `/.well-known/oauth-authorization-server` on the API origin
- **THEN** the document lists `S256` in `code_challenge_methods_supported` and `none` in `token_endpoint_auth_methods_supported`

### Requirement: Sign-in uses the tracker's own accounts

The authorization endpoint SHALL sign the person in with the tracker's user accounts, by
password or by an emailed one-time code, and SHALL refuse an account that is unverified or
unapproved exactly as the API's own sign-in does.

#### Scenario: An unapproved account

- **WHEN** a person whose account is verified but not approved signs in on the authorization page
- **THEN** the page refuses the sign-in and no authorization code is issued

### Requirement: Consent chooses read or write

After sign-in the authorization endpoint SHALL show which client is asking, the host it will
return to, and a choice of read or read-and-write access, and SHALL issue an authorization code
only when the person approves. Denial SHALL return `access_denied` to the client.

#### Scenario: The person grants read only

- **WHEN** a client asks for `read write` and the person chooses read
- **THEN** the token response's `scope` is `read` and the minted key is read-scoped

#### Scenario: The person denies

- **WHEN** the person chooses Deny
- **THEN** the browser returns to the client's redirect URI with `error=access_denied`

### Requirement: Client registration by metadata document or pre-registration

The authorization server SHALL accept a `client_id` that is an HTTPS URL with a path, fetch the
Client ID Metadata Document it names, and require that document's `client_id` to equal the URL
and its `redirect_uris` to contain the requested redirect URI. It SHALL also accept the client
ids it was configured with. It SHALL offer no dynamic client registration. A redirect URI SHALL
match exactly, except that a loopback redirect URI matches with any port.

#### Scenario: Claude Code signs in with its metadata document

- **WHEN** Claude Code sends its metadata-document URL as `client_id` with a redirect to `http://localhost:<port>/callback`
- **THEN** the authorization page is shown

#### Scenario: A redirect URI the document does not list

- **WHEN** an authorization request names a redirect URI absent from the client's registered list
- **THEN** the authorization server shows an error page and does not redirect

### Requirement: A grant mints an API key

Exchanging an authorization code SHALL mint an API key record for the signed-in user, tied to the
client and carrying the granted scope, and SHALL return that key as the access token with a
refresh token. The record SHALL appear in the user's key list beside hand-minted keys, and
revoking or deleting it SHALL end the grant, so its refresh token no longer works.

#### Scenario: The key appears in the user's list

- **WHEN** a grant completes for a user
- **THEN** the user's `api_keys` list shows a record whose `client_id` names the client

#### Scenario: Revoking the record ends the grant

- **WHEN** the user revokes that record and the client then presents its refresh token
- **THEN** the token endpoint answers 400 `invalid_grant`

### Requirement: Refresh issues a new key and rotates the refresh token

A refresh SHALL replace the grant's key with a new key value and a new refresh token; the
previous key and refresh token SHALL stop working at once. Presenting a refresh token that was
already used SHALL end the grant.

#### Scenario: A refresh

- **WHEN** a client presents a valid refresh token
- **THEN** it receives a new access token and refresh token, and the previous access token answers 401

#### Scenario: A replayed refresh token

- **WHEN** a refresh token already exchanged once is presented again
- **THEN** the token endpoint answers 400 `invalid_grant` and the grant's current key answers 401

### Requirement: A key can read its own scope

`GET /api/tracker/me` under an API key SHALL report the key's id, scope, expiry and client, so a
client can tell what the key may do without reading the key collection.

#### Scenario: A read key asks who it is

- **WHEN** a read key calls `GET /api/tracker/me`
- **THEN** the answer carries `key.scope` equal to `read`
