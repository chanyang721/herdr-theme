# Harness workflow integration

Required contract: `HERDR-WORKFLOW-1` (2026-11-11).

The [canonical workflow contract](https://github.com/chanyang721/ai-workflows/blob/main/docs/herdr-workflow-contract.md) is owned by
`ai-workflows`, at `docs/herdr-workflow-contract.md`. Read that contract before
assigning, reviewing, displaying, archiving, or closing harness work. This file
is a repository adapter, not an independent copy of the policy. Until the
coordinated changes reach main, use the reviewed contract from the integration
checkout; a missing remote document is not evidence that the requirement is absent.
Record the contract revision and engine/theme revisions in verification evidence.

## Theme obligations

- Derive task progress and cleanup state from canonical harness evidence. A CLI
  response ending must not turn an incomplete task into a completed task.
- Show allocation, work, review/decision waiting, archiving, cleanup waiting,
  and closing consistently. Keep cleanup information legible without hover
  within the existing single row; do not add another panel or a second row.
- Keep issue-to-agent and parent-to-child relationships visible. Preserve pinned
  spaces and the configured project ordering.
- Verify feed data and actual rendered transitions separately, including row
  removal after confirmed closure. A screenshot of an idle row does not prove
  that the closing transition was shown.
- Reuse the fixed harness test space and preserve it. Validate unpinned-space
  expiry separately. Do not remove active input, work, or pending approvals.
- Commit only portable defaults and installation/update changes; keep machine
  paths, credentials, and live session IDs out of shared configuration.

## Release evidence

Use the canonical evidence template. Independent review, installation, visible
behavior, and remote publication are separate milestones. The current user
request requires automatic parallel collaboration and full lifecycle validation
before publishing the related changes. An adapter document is not proof that
the implementation already satisfies those requirements.
