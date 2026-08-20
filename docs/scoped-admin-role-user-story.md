# User story: scoped admin role for board-shape management

Status: implemented and verified

Tracking: manager board cards `060` (plan) and `061` (implementation)

Last reviewed: 2026-08-20

## Outcome

Add an `admin` role between `write` and `owner` so a human or bot can reshape
boards inside one project subtree or one space without receiving company-wide
owner authority.

This is a least-privilege role, not a smaller owner account. An admin inherits
ordinary board work from `write` and adds one capability: managing durable board
policy for projects inside its scope. Company control and emergency overrides
remain owner-only.

## User story

> As a company owner, I want to grant a bot or human admin access to one project
> subtree or one space, so they can maintain the boards' workflow shape without
> gaining access to the rest of the company or to owner-only security and
> recovery controls.

For the delegated admin:

> As a scoped admin, I want the board editor and snapshot-sync API to accept
> board-policy changes for projects I can reach, so I can manage lanes, workflow
> rules, fields, templates, automation, and rollups without an owner credential.

## Review of the current implementation

At planning time, the hosted manager had three ordered roles in
`worker/src/security.ts`: `read < write < owner`. Scope is independent and is
one of `org`, `space`, or `project`; project scope includes the selected project
and all descendants.

Several existing decisions are good foundations for this feature:

- all credential forms resolve to one `Identity`, so a password, session, and
  API key receive the same role and scope;
- project routes check reach before dispatch, so a scoped identity cannot open a
  sibling project merely by guessing its id;
- owners are normalized to `org` scope on create, update, and restore;
- `PUT /api/projects/:id/config` is transactional, validates the complete board
  configuration, migrates stranded cards, and emits board and company audit
  events;
- the browser already derives role flags centrally from `/api/org`.

The important authorization gap is that the editor route is not the only way to
change board shape. `PUT /api/projects/:id/import` currently requires only
`write`, and `ProjectDO.importDocs()` replaces the stored `board.yaml` along with
the cards. A write bot can therefore change lanes and board policy through
`botflow push` even though the direct config endpoint is owner-only. The feature
is incomplete unless both paths enforce the same capability.

Two dedicated write-level configuration mutations are intentionally different:
saved filters and a member's own lane subscriptions. They are collaboration
features rather than board-policy authority and remain available through their
existing narrow endpoints. A full snapshot is not a narrow endpoint, so a write
identity may only push it when its `board.yaml` is unchanged.

## Proposed permission model

The ordered role set becomes:

```text
read < write < admin < owner
```

Role and scope continue to answer separate questions:

- role answers **what** an identity may do;
- scope answers **where** it may do it.

There are two role/scope invariants:

1. `owner` is always `org` scoped. This preserves the existing meaning of owner
   as full company access.
2. `admin` must be `space` or `project` scoped. An org-scoped admin is rejected;
   whole-company administration remains an owner responsibility.

`read` and `write` retain their existing `org`, `space`, and `project` scope
options. Member `kind` stays orthogonal to role, so both humans and bots may be
admins. A project-scoped admin reaches that project and its descendants, matching
the existing project-scope contract. A space-scoped admin reaches every project
in that space and nothing in another space.

### Capability matrix

| Capability within the identity's scope | read | write | admin | owner |
|---|:---:|:---:|:---:|:---:|
| View boards, cards, directory names, and project activity | yes | yes | yes | yes |
| Create and mutate ordinary cards | no | yes | yes | yes |
| Run automation, buttons, filters, and own lane subscriptions | no | yes | yes | yes |
| Push a snapshot whose `board.yaml` is byte-identical to the stored config | no | yes | yes | yes |
| Edit board policy with `PUT .../config` | no | no | yes | yes |
| Push a snapshot that changes `board.yaml` | no | no | yes | yes |
| Create a sub-project below a reached project | no | yes | yes | yes |
| Use `force` to bypass claims, strict flow, or denied WIP | no | no | no | yes |
| Create/delete spaces or root projects; hard-delete any project | no | no | no | yes |
| Manage members or another member's API keys/password | no | no | no | yes |
| Manage public shares, webhooks, email routes, or subscriptions | no | no | no | yes |
| Change company settings; import/export the company; view company audit | no | no | no | yes |

Personal API keys and member-scoped feed capabilities keep their current rules;
the new role does not change credential ownership or turn private feeds into an
admin function.

## What counts as board shape

For this story, board shape means durable workflow and presentation policy in a
project's `board.yaml`, including:

- board config name, id mode, and declared features;
- lanes, display names, canonical mappings, ordering, substates, WIP limits, and
  WIP enforcement;
- label definitions and typed custom-field definitions;
- card templates and named blockers;
- board/card buttons and event rules;
- scheduled automation policy;
- rollup policy;
- lane-migration choices required by a structural edit.

The UI editor does not currently expose every raw field, but authorization must
cover the complete config accepted by the API and snapshot import. Unknown or
future `board.yaml` keys must not become a way for `write` to smuggle policy
changes.

Space-level administration means that one space-scoped identity may perform the
same project-board operation on each project in that space. This story does not
introduce a separate space config, inherited board templates, or a bulk reshape
endpoint.

Changing the board config's `name` is included. Renaming or reparenting the
registry's space/project nodes is a separate hierarchy concern and is not added
here.

## API and authorization contract

### Role helpers

Add `admin` to `Role`, `validRole`, and the rank used by `roleAllows`.
`roleAllows` must fail closed for unknown values and satisfy:

```text
owner  allows owner, admin, write, read
admin  allows admin, write, read; never owner
write  allows write, read; never admin or owner
read   allows read only
```

Add a route helper with a board-policy-specific error, for example:

```text
requireAdmin() -> 403 "admin or owner required to reshape this board"
```

Do not replace `requireOwner()` globally. Each owner route stays owner-only unless
it is explicitly identified in this story.

### Direct board edits

Change `PUT /api/projects/:id/config` from `requireOwner()` to
`requireAdmin()`. Authentication and scope reach are still checked first. The
existing validation, card migration, ProjectDO event, and registry audit remain
mandatory and record the authenticated username.

`GET /api/projects/:id/config` remains readable by every identity that reaches
the project.

### Snapshot sync/import

`PUT /api/projects/:id/import` keeps `write` as the minimum role for card
snapshots, with this additional rule:

- if the incoming config text is exactly equal to the stored config text, a
  write identity may import the cards;
- if the config text differs in any byte, the caller must satisfy
  `requireAdmin()`;
- an unauthorized config change returns `403`, and neither config nor cards are
  changed;
- an authorized config change is called out in both the project import event and
  the registry audit log.

Byte equality is deliberate. A semantic comparison could silently authorize
changes to comments, preserved extension keys, ordering, or future fields the
current parser does not understand. A write bot whose local config is stale must
pull the admin-authored config or ask an admin to perform the push; it must never
overwrite policy as a side effect of syncing cards.

The compare and commit must occur in the same ProjectDO operation. Pass an
explicit `canReshape` decision into `importDocs()` (or use an equivalent atomic
design), have the DO re-check the config difference, and return a typed forbidden
result that the Worker maps to `403`. Do not implement this as a race-prone
export-then-import check in the Worker alone.

### Explicit owner-only boundary

The following stay behind `requireOwner()` and `IS_OWNER`:

- company name, theme/preferences, company import/export/demo, and company
  activity;
- member lifecycle, password resets, and management of another member's keys;
- space creation/deletion, root-project creation, and project hard deletion;
- public share management and the organization capability inventory;
- webhook and email integration configuration/history/replay;
- every `force` path, including button, bulk, add, claim, and move overrides.

An admin still inherits the existing write-level ability to create a sub-project
inside a project it reaches. This story neither broadens nor removes that
behavior.

## Registry, persistence, and export compatibility

No SQLite schema migration is needed because `members.role` is stored as text.
Existing members keep their current roles and credentials.

Registry validation must enforce:

- creating or updating an admin with `org` scope fails with a useful `400`;
- creating or updating an admin requires a live space/project id;
- promoting any member to owner normalizes its scope to `org`;
- demoting an owner to admin requires a space/project scope in the same request;
- the last-live-owner invariant is unchanged;
- deleting an admin's scoped space/project disables it through the existing
  dangling-scope cleanup;
- role/scope changes take effect for existing sessions, basic auth, and API keys
  without reissuing credentials.

Company export should advance to version 5 because `admin` adds a value to the
persisted member-role enum. Version 5 documents the new role and preserves its
space/project scope. Imports continue to accept versions 1 through 4 with their
existing role set. Version 5 import must:

- reject an org-scoped admin;
- reject a missing or dangling admin scope before changing company state;
- remap exported space/project scope ids and restore the admin exactly;
- continue to normalize every owner to org scope;
- remain restore-grade for member key hashes and active capabilities.

This explicit version bump makes downgrade failure clear: an older manager sees
an unsupported export version instead of reporting vague malformed member
metadata for a valid admin.

## Browser experience

Derive a new `CAN_SHAPE` (or equivalently named) flag alongside `CAN_WRITE` and
`IS_OWNER` in `adoptOrg()`:

```text
CAN_WRITE = role is write, admin, or owner
CAN_SHAPE = role is admin or owner
IS_OWNER  = role is owner
```

Use an explicit role set/rank rather than `role !== 'read'`, so an unknown role
does not make the UI optimistically writable.

- Show **Edit board** when `CAN_SHAPE` is true.
- Keep owner-only settings, member administration, public sharing,
  integrations, deletion controls, and force affordances tied to `IS_OWNER`.
- Add `admin (reshapes boards in its scope)` to the owner-only member form.
- When `admin` is selected, offer only space and project scopes and require a
  choice. When `owner` is selected, show/fix the scope as whole company. Keep
  `read` as the default role for a new member.
- Continue to display `admin` in the header identity badge, member table, key
  provisioning explanation, and `/api/whoami` response.
- Hiding controls is a usability feature only; every API route enforces the same
  policy independently.

## Acceptance criteria

1. An owner can create a human or bot with role `admin` and a project or space
   scope; an org-scoped admin is rejected.
2. A project-scoped admin can edit the selected board and descendant boards but
   gets `403` for its parent, siblings, and projects in other spaces.
3. A space-scoped admin can edit every board in that space but gets `403` for a
   project in another space.
4. A write member still performs ordinary board work but gets `403` from the
   direct board-config endpoint.
5. A write snapshot push with an unchanged config succeeds; a write push with a
   changed config gets `403` and leaves both the config and card set byte-for-byte
   unchanged.
6. The same changed-config push succeeds for an in-scope admin and records the
   authenticated actor and the fact that board policy changed.
7. Admin credentials cannot manage company settings, members, another member's
   keys, shares, integrations, hard deletion, root hierarchy, company data, or
   company audit.
8. Admin credentials cannot use `force`, including through less-obvious button,
   bulk, create, claim, and move paths.
9. The browser exposes the board editor to an in-scope admin while all
   owner-only UI remains absent.
10. Promoting/demoting a member updates all of its existing credential forms
    immediately; no stale session or key retains its old capability.
11. A version 5 company export round-trips project- and space-scoped admins, and
    versions 1 through 4 continue to restore.
12. Invalid and unknown roles fail closed in the policy layer, API, import
    validator, and browser capability derivation.

## Test plan

### Pure policy tests

Update `test/security-core.test.ts` with the complete four-role truth table and
unknown-role denials. Keep the existing scope vectors and add assertions that
the role rank does not bypass a failed scope check.

### Real Worker API tests

Extend `test/worker.test.ts` with an owner plus these identities and credentials:

- project-scoped write bot;
- project-scoped admin bot;
- space-scoped admin;
- an out-of-scope project/space target.

Exercise direct config edits, descendant/sibling reach, every owner-only class,
and all force entry points. For snapshot sync, capture exports before and after
an unauthorized changed-config import and assert complete atomic equality. Then
repeat with an identical config as write and a changed config as admin.

Add create/update/restore cases for owner normalization, admin scope rejection,
last-owner demotion, immediate role-change effects on sessions/keys, version 5
round-trip, and legacy version acceptance.

### Browser contract tests

Update `test/ui.test.ts` to assert that role derivation refreshes `CAN_SHAPE`, the
admin sees the editor but no owner-only controls, the member role picker lists
admin without making it the default, and its scope picker cannot submit org.

### Required verification

```sh
node --test
node --run typecheck
tsc --noEmit -p worker
node src/cli/botflow.ts lint --board worker/.botflow
```

No conformance fixture changes are expected: this is hosted-manager
authorization and company-export behavior, not a change to the git-native board
format in `spec/SPEC.md`.

## Suggested implementation sequence

1. Add the role/scope contract and failing pure-policy, registry, and export
   tests.
2. Implement `admin` validation/ranking and registry scope invariants, including
   version 5 import/export handling.
3. Add `requireAdmin()`, reclassify only the board-config route, and make
   snapshot config-change authorization atomic inside ProjectDO.
4. Add end-to-end authorization/audit tests before changing the browser.
5. Add `CAN_SHAPE`, admin member-form behavior, editor visibility, and UI tests.
6. Update the README role documentation and run the complete verification set.

Each slice should remain zero-runtime-dependency and use erasable TypeScript.

## Risks and mitigations

- **Accidentally promoting every owner surface to admin.** Use a new narrow
  `requireAdmin()`/`CAN_SHAPE` gate and retain an explicit owner-only route
  matrix in tests.
- **Snapshot sync bypass.** Authorize config differences inside the same DO
  operation that commits the snapshot, and test atomic denial.
- **Stale repo config breaks a write bot's push.** Return a precise `403` telling
  it that an admin-authored config must be pulled; document that the first push
  establishing a non-default shape needs admin.
- **Scope confusion.** Reject org-scoped admin at every write/import boundary and
  reuse the existing `scopeAllows` subtree semantics.
- **Export downgrade ambiguity.** Emit version 5 and preserve explicit legacy
  readers rather than silently changing version 4's role enum.
- **UI-only authorization.** Treat browser flags only as affordance control;
  retain server-side checks for every route.

## Non-goals for this story

- arbitrary per-capability ACLs or custom roles;
- delegated member, key, share, or integration administration;
- admin use of owner `force` overrides;
- space-wide templates, config inheritance, or bulk board reshaping;
- creating, renaming, reparenting, or deleting space/root hierarchy as admin;
- changing the local filesystem CLI's trust model;
- changing the board file format or adding runtime dependencies.

## Definition of done

The story is complete when an owner can issue a project- or space-scoped admin
bot credential, that credential can reshape exactly the boards in its scope
through both the direct API and snapshot sync, a write bot cannot reach either
shape-changing path, and the admin demonstrably retains none of the company-wide
or emergency powers reserved for owner.
