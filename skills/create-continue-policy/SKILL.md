---
name: create-continue-policy
description: Use when creating or revising CONTINUE.md for pi-jev-continue, when routine work repeatedly requests approval, or when a continuation policy has become tied to a particular plan or task.
---

# Create a Continuation Policy

Produce durable rules for continuing, asking, and stopping—not a plan, progress report, or authorization record. The policy should remain useful after the current task changes.

## Workflow

1. Establish the requested scope. Use `<project>/.pi/CONTINUE.md` for the directory where pi will run; use `~/.pi/CONTINUE.md` only for a requested personal policy. Read existing policies before editing. Preserve intentional preferences and unrelated rules; do not overwrite the other scope.
2. Read relevant instructions and available examples of unwanted stops. Extract stable decision principles from logs, not current implementation facts or historical approvals. Ask only about unresolved policy tradeoffs that change behavior.
3. Write concise Markdown in the requested language. Cover scope, routine delegation, continuation, human dependencies, stopping, and evidence reporting. Refer to current user instructions and project procedures generically rather than duplicating them.
4. Apply the task-swap check: imagine a different goal, completed milestone, and changed workflow. Every rule should still make sense. Remove issue IDs, dates, PR numbers, active-plan paths, remaining-work counts, and task-specific ordering exceptions. Do not turn a temporary offline restriction or concurrency limit into a permanent default.
5. Validate, then report the edited path, material choices, checks performed, and activation instructions. Do not activate automation or grant new permissions merely to test the document.

## Policy Shape

Adapt these principles; retain existing user preferences rather than replacing them mechanically.

```markdown
# Continuation Policy

## Scope
Use the current request and authoritative project instructions for goals,
dependencies, procedures, and approvals. This file defines decision rules only.

## Continue
- Continue concrete unfinished work within the goal and available permissions.
- Decide routine research, implementation, planning, documentation, and
  verification methods without redundant approval requests.
- Respect explicit approval gates; creating a plan does not create a new gate.
- Inspect available evidence yourself. Restrictions on later operations do not
  block a next action that does not use them.

## Ask or Stop
- Ask when the next action needs unavailable human-only information, a changed
  goal, or missing required approval. Observe explicit user stop instructions.
- Policy and automatic answers do not authorize destructive, privileged,
  financial, sensitive-data, or external operations.
- Stop when the requested outcome and required verification are complete.
  Continue optional improvements only when the goal includes them and their
  benefit can be checked. Do not invent work to prolong the loop.

## Report
State observed results, one immediate next action, and its human prerequisites.
Separate later restrictions. Disclose incomplete work and unverified claims;
never include secrets.
```

## Runtime Contract

| Concern | Rule |
| --- | --- |
| Precedence | Explicit user instructions > project > personal > defaults; retain nonconflicting rules. A broad goal does not waive narrower stop conditions. |
| Discovery | Only the two paths above; no ancestor or Git-root search. |
| Updates | Snapshot at `/jev-on`; edits require stopping the current run and reactivating. `/jev-status` shows sources. |
| Limits | Regular UTF-8 files, 8000 combined content bytes; total judgment state remains bounded at 24000 bytes. |
| Privacy | Contents and absolute paths reach the development model, TypeSafe, and logs. |

## Validation

Measure both files together; do not truncate another policy to fit. Use the actual loader when available. Walk through routine work, documentation, explicit approval, future-only restrictions, completion, and user-stop cases. If authorized live evaluation is available, report actual outcomes—including conservative stops. Never lower thresholds or add task-specific exceptions just to pass an example.
