# Security Policy

## Supported Versions

This project is experimental. Security fixes are provided for the latest published version only.

## Reporting a Vulnerability

GitHub private vulnerability reporting may not always be enabled for this repository.

Until a dedicated private reporting channel is documented here, do **not** open a public issue with exploit details, credentials, local paths, or reproduction steps that could expose user data or local system access.

Instead:

1. open a minimal public issue asking for a private contact path, or
2. contact the maintainer through their GitHub profile and request a private handoff.

## Scope

This plugin does not intentionally read credentials, write arbitrary user files, or execute shell commands. It observes OpenCode session events, injects goal context into prompts, and sends continuation prompts through OpenCode's SDK client.

Relevant security-sensitive areas include:

- prompt-injection resistance for goal text
- unexpected auto-continuation behavior
- incorrect command or hook handling across OpenCode versions
- leakage of goal text through logs or status output
- malformed persisted state causing stale or unexpected goal recovery

## Threat Model and Trust Boundaries

The plugin is an orchestration layer, not a sandbox. OpenCode, the selected model/provider, enabled tools, repository instructions, and the local operating-system account remain separate trust boundaries. The plugin does not grant a model new tool permissions, but auto-continuation gives already-authorized tools more opportunities to run. Use OpenCode's permission controls and avoid unattended goals in repositories or sessions you do not trust.

The following inputs are untrusted:

- goal objectives, criteria, constraints, blockers, and completion evidence
- assistant/provider output and completion markers
- session events and SDK responses
- persisted state and lifecycle-ledger content
- repository files and instructions encountered by the agent

The plugin bounds and escapes prompt-control-like goal text, validates public tool inputs, limits completion-claim size, coalesces duplicate idle events, and pauses recovered goals. These controls reduce accidental loops and prompt confusion; they do not turn model output into trusted data or prove that cited evidence is true. Enable the independent completion auditor for higher-assurance work and keep its default fail-closed failure policy.

## Data Stored and Exposed

Persistence may contain objectives, criteria, constraints, assistant checkpoints, lifecycle events, blockers, completion evidence, changed-file names, and commands reported by the agent. Files are created with owner-only permissions where the platform supports POSIX modes, but filesystem permissions do not provide encryption at rest. State is project-local by default and is not intentionally uploaded by this plugin; the configured model/provider still receives prompt context through OpenCode. The lifecycle ledger rotates at a finite size and retention count, but retained generations still contain sensitive task text until they are rotated out or deleted.

Status and history are session-scoped. The plugin intentionally avoids a process-wide diagnostic dump because a long-running OpenCode host may serve multiple projects or sessions. Before sharing logs or persistence files, remove secrets, proprietary text, usernames, absolute paths, and provider identifiers.

## Security Assumptions and Residual Risk

- A compromised OpenCode host, provider, dependency, or local account is outside the plugin's protection boundary.
- Completion auditing improves confidence but is not a cryptographic attestation and may share the same provider failure modes as the working agent.
- Disabling persistence avoids local state files but also removes restart recovery and ledger durability.
- Setting the auditor's `failurePolicy` to `approve` weakens completion integrity and should be treated as a compatibility-only escape hatch.
- Experimental OpenCode hook or SDK changes can alter interception, display, or continuation behavior; re-test the exact version/provider combination used for unattended work.

Goal text is wrapped in `<goal_objective>` tags and labeled as user-provided task data. The plugin neutralizes opening and closing tags that match its prompt-control vocabulary, including role-like tags, before inserting user-controlled text. This is defense in depth for a plaintext model prompt, not a privilege boundary: treat goal text as untrusted content and do not assume tag escaping can make arbitrary third-party instructions safe.
