## Purpose

How a person gets an account, signs in, manages the display name and API keys, and how an app
administrator approves pending accounts, through a web app the PocketBase server itself serves.

## ADDED Requirements

### Requirement: The server serves the account app at /account/

The PocketBase image SHALL serve the account app's built files under `/account/`, answer every
path under `/account` with the security headers the contract names on GET and HEAD, and SHALL leave every other
path answering as it did before the app existed: a path that matches no route or file still
answers 404, never the app's page.

#### Scenario: The app's page

- **WHEN** a browser requests `/account/`
- **THEN** the server answers 200 `text/html` with the contract's `Content-Security-Policy` and `X-Frame-Options: DENY`

#### Scenario: An unknown API path

- **WHEN** a client requests `/api/nope`
- **THEN** the server answers 404 with a JSON body, as before

### Requirement: A dot-segment path never reaches the account app

A GET or HEAD path whose decoded form holds a `.` or `..` segment (raw or percent-encoded, under
`/account` or any other prefix) and that no route matches SHALL answer as a server without the
app does, 404 `File not found.` without the security headers, and SHALL never serve the app's
files. This is the one exception to the headers on paths under `/account`.

#### Scenario: An encoded parent segment

- **WHEN** a client requests `/api/..%2faccount/`
- **THEN** the server answers 404 `{"data":{},"message":"File not found.","status":404}` with no `Content-Security-Policy`

### Requirement: Account mail links to the account app

The signup mail, the password-reset mail and the verification mail SHALL link to the account
app's matching screen on the server's public URL. The email-change mail SHALL keep its link.

#### Scenario: The signup mail

- **WHEN** a person signs up with an email address
- **THEN** the mail sent to it links to `{APP_URL}/account/#/auth/password-reset-confirm?token=<token>`

#### Scenario: A password reset

- **WHEN** a verified account asks for a password reset
- **THEN** the mail links to `{APP_URL}/account/#/auth/password-reset-confirm?token=<token>`

### Requirement: Signup takes an email and a name, and the mail sets the password

The sign-up screen SHALL ask for an email address and a display name only, and after a
successful signup SHALL tell the person to open the mailed link to choose a password, with a
way to send a new link. It SHALL never send a password at signup and never ask the server for a
verification mail.

#### Scenario: A new person signs up

- **WHEN** a person submits a new email address and a name
- **THEN** the app shows the check-your-email screen for that address, and the account exists unverified and unapproved

#### Scenario: Choosing the password from the mail

- **WHEN** the person opens the mailed link and submits a password of at least 8 characters twice
- **THEN** the app confirms the password is saved and says an administrator must approve a new account before it can sign in

#### Scenario: An expired link

- **WHEN** the person submits a password from a link whose token is invalid or expired
- **THEN** the app says the link is invalid or has expired and offers to request a new one

### Requirement: Sign-in tells a waiting account apart from wrong credentials

The sign-in screen SHALL sign in by email and password, and through each sign-in provider the
server has enabled. A refusal for wrong credentials, for an account that cannot sign in yet, and
for too many attempts SHALL each show its own message.

#### Scenario: Wrong password

- **WHEN** a person submits a wrong password
- **THEN** the app shows "Wrong email or password."

#### Scenario: An account awaiting approval

- **WHEN** a person whose account is verified but not approved submits the right password
- **THEN** the app shows the not-yet-approved message and stays signed out

### Requirement: Profile shows the account and edits the display name

The profile screen SHALL show the account's email address read-only, let the person change the
display name, and list which enabled sign-in providers are linked, offering to link each one
that is not.

#### Scenario: Renaming

- **WHEN** a signed-in person saves a new non-blank name
- **THEN** the name is stored trimmed and shown after a reload

#### Scenario: A blank name

- **WHEN** a signed-in person saves a name of only spaces
- **THEN** the app shows "Cannot be blank." under the name and nothing changes

### Requirement: API keys are listed, created once-shown, and revoked

The keys screen SHALL list every key of the signed-in person with its name, level, reach,
client, created, expiry, last use and status, and never a secret. Creating a key SHALL take a
name, a level, a reach and an optional expiry date, and SHALL show the new secret exactly once,
in the dialog that created it. Revoking SHALL ask for confirmation and then revoke the key.

#### Scenario: Creating a key

- **WHEN** a signed-in person creates a read key reaching every workspace
- **THEN** the dialog shows a `tmk_` secret, and after the dialog closes the list shows the key as Active with no secret

#### Scenario: Revoking a key

- **WHEN** the person confirms revoking an active key
- **THEN** the list shows that key as Revoked, and the key answers 401 on its next use

#### Scenario: A reach with no workspace

- **WHEN** the person chooses "One workspace" and no workspace
- **THEN** the app shows "Choose the workspace this key is limited to." and creates nothing

### Requirement: App administrators approve pending accounts

The approvals screen SHALL be offered only to a signed-in person the server answers as an app
administrator, SHALL list the accounts waiting for approval or for email confirmation, and SHALL
approve one on request.

#### Scenario: An administrator approves

- **WHEN** an app administrator approves a waiting account
- **THEN** the account leaves the waiting list when its email is already confirmed, and otherwise stays listed as waiting for email confirmation; it can sign in once both hold

#### Scenario: Anyone else

- **WHEN** a signed-in person who is not an app administrator opens the approvals screen
- **THEN** the app shows "This page is for app administrators." and no navigation entry leads there

### Requirement: Sign out

Signing out SHALL forget the session in this browser and return to the sign-in screen; a screen
behind sign-in SHALL send a signed-out visitor to sign in and back afterwards.

#### Scenario: Signing out

- **WHEN** a signed-in person chooses Sign out
- **THEN** the app shows the sign-in screen and the keys screen redirects to it
