/**
 * OpenCode 2 host bridge.
 *
 * OpenCode 2 replaced the V1 plugin surface (`server()` returning a flat hook
 * map, `chat.*` hooks, `command.execute.before`, `experimental.*` transforms)
 * with `Plugin.setup(ctx)`, where hooks are registered on the domain that owns
 * the operation. The goal workflow itself — state machine, persistence lease,
 * budgets, tool surface — is host-agnostic, so this module keeps every V1 hook
 * contract intact and adapts the V2 host onto it:
 *
 *   - `createV2Client`   presents V2's `ctx.session` domain as the session SDK
 *                        the plugin already speaks (messages, promptAsync,
 *                        createChild, get, update, abort, children, status),
 *                        normalizing V2 message records into the message shape
 *                        the goal loop consumes.
 *   - `toV1Event`        normalizes the V2 event stream into the V1 event
 *                        shapes (`session.idle`, `session.error`,
 *                        `session.compacted`, `message.updated`,
 *                        `session.status`, `session.updated`) the plugin's
 *                        event hook already understands.
 *   - `createV2Setup`    registers the V1 hooks on V2 domains (prompt, context,
 *                        compaction, tool, command, agent, tool transform) and
 *                        returns the plugin cleanup function.
 *
 * Divergences from V1 are documented in docs/compatibility.md.
 */

import { z } from "zod"
import { applyNativeGoalConfig } from "./native-agent-config.js"

export const PLUGIN_ID = "opencode-goal-plugin"

/** Public marker key carried in prompt metadata and message metadata. */
export const MARKER_KEY = "opencode-goal-plugin"

/**
 * Description of the plugin-owned slash command. It doubles as the ownership
 * sentinel: a registered command with this exact description is the plugin's,
 * anything else with the same name is a legacy config `command` entry that is
 * shadowing the plugin handler.
 */
export const GOAL_COMMAND_DESCRIPTION =
  "Run the durable goal workflow (set, status, pause, resume, clear)."

const AGENT_ALIAS_ACTIONS = Object.freeze({
  bash: ["shell"],
  task: ["subagent"],
  subtask: ["subagent"],
  write: ["edit"],
  patch: ["edit"],
})

/**
 * V2's plugin context has no structured log API (V1's `client.app.log`), so
 * advisory diagnostics go to the host process console: the same fallback the
 * plugin already uses when `app.log` is unavailable.
 */
const logWarn = (...args) => {
  console.warn("[goal-plugin]", ...args)
}

const logError = (...args) => {
  console.error("[goal-plugin]", ...args)
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textFromParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((part) => part && part.type === "text" && !part.ignored)
    .map((part) => part.text || "")
    .join("\n")
    .trim()
}

function unwrap(value) {
  if (!isPlainObject(value)) return value
  const keys = Object.keys(value)
  if (!("data" in value)) return value
  if (keys.length === 1 || (keys.length === 2 && "location" in value)) return value.data
  return value
}

/**
 * V2 events are broadcast for every location the server serves, while V1 hosts
 * only delivered project events. Goal state is keyed by session, so an event
 * from another project must never reach it.
 */
export function eventBelongsToLocation(event, directory) {
  const location = isPlainObject(event?.location) ? event.location : null
  if (!location || typeof location.directory !== "string") return true
  if (typeof directory !== "string" || !directory) return true
  return normalizeDirectory(location.directory) === normalizeDirectory(directory)
}

function normalizeDirectory(value) {
  const directory = String(value)
  let end = directory.length
  while (end > 0 && (directory[end - 1] === "/" || directory[end - 1] === "\\")) end--
  const trimmed = directory.slice(0, end)
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed
}

function sessionIDOf(input) {
  if (typeof input === "string") return input
  if (!isPlainObject(input)) return ""
  if (typeof input.sessionID === "string") return input.sessionID
  if (isPlainObject(input.path) && typeof input.path.id === "string") return input.path.id
  return ""
}

function toErrorInfo(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
  }
}

/* ------------------------------------------------------------------ *
 * V2 message normalization
 * ------------------------------------------------------------------ */

/**
 * Convert a V2 session message into the message shape the goal loop reads:
 * `role`/`id`/`sessionID` at the top level, `parts` for text and tool
 * traffic, V2 token usage (identical to V1's `{input, output, reasoning,
 * cache}`), and a derived `parentID` that links an assistant message to the
 * user message that opened its turn (V2 messages carry no parent link).
 */
export function normalizeMessage(message, sessionID, parentID = "") {
  if (!isPlainObject(message)) return null
  const id = typeof message.id === "string" ? message.id : ""
  const role = typeof message.type === "string" ? message.type : ""
  const parts = []

  if (role === "user") {
    const marker = message.metadata?.[MARKER_KEY]
    const textPart = {
      type: "text",
      text: typeof message.text === "string" ? message.text : "",
      messageID: id,
      sessionID,
    }
    if (isPlainObject(marker)) {
      textPart.synthetic = true
      textPart.metadata = { [MARKER_KEY]: marker }
    }
    parts.push(textPart)
    for (const file of Array.isArray(message.files) ? message.files : []) {
      if (!isPlainObject(file)) continue
      parts.push({ type: "file", uri: file.uri, name: file.name, messageID: id, sessionID })
    }
  } else if (role === "assistant") {
    for (const content of Array.isArray(message.content) ? message.content : []) {
      if (!isPlainObject(content)) continue
      if (content.type === "text") {
        parts.push({ type: "text", text: String(content.text || ""), messageID: id, sessionID })
      } else if (content.type === "reasoning") {
        // Reasoning is never goal-visible text: `getText` only joins `text`
        // parts, so keeping the type distinct prevents thinking output from
        // being read as the assistant's answer.
        parts.push({ type: "reasoning", text: String(content.text || ""), messageID: id, sessionID })
      } else if (content.type === "tool") {
        parts.push({
          type: "tool",
          toolName: content.name,
          id: content.id,
          messageID: id,
          sessionID,
        })
      } else {
        parts.push({ type: content.type || "text", messageID: id, sessionID })
      }
    }
  }

  const normalized = {
    id,
    sessionID: typeof message.sessionID === "string" ? message.sessionID : sessionID,
    role,
    time: message.time,
    parts,
    metadata: message.metadata,
  }
  if (role === "assistant") normalized.parentID = parentID
  if (isPlainObject(message.tokens)) normalized.tokens = message.tokens
  if (typeof message.cost === "number") normalized.cost = message.cost
  if (typeof message.agent === "string") normalized.agent = message.agent
  if (isPlainObject(message.model)) normalized.model = message.model
  if (isPlainObject(message.error)) normalized.error = message.error
  if (typeof message.summary === "boolean") normalized.summary = message.summary
  return normalized
}

/** Normalize a whole transcript, deriving each assistant message's parent. */
export function normalizeMessageList(messages, sessionID) {
  const normalized = []
  let lastUserMessageID = ""
  for (const message of Array.isArray(messages) ? messages : []) {
    const entry = normalizeMessage(message, sessionID, lastUserMessageID)
    if (!entry) continue
    if (entry.role === "user") lastUserMessageID = entry.id
    normalized.push(entry)
  }
  return normalized
}

/* ------------------------------------------------------------------ *
 * V2 -> V1 event normalization
 * ------------------------------------------------------------------ */

/**
 * Host bookkeeping shared by the client, the hooks, and the event bridge:
 * children/status maps for the active-children gate, and the id of the last
 * admitted user message per session (used to derive assistant parent links,
 * which V2 does not carry on the wire).
 */
export function createHostState() {
  return {
    statuses: new Map(),
    children: new Map(),
    assistantAgents: new Map(),
    lastPromptMessageIDs: new Map(),
    onCommandRegistryChanged: null,
    disposed: false,
  }
}

// V1 tool names that duplicate a canonical `goal_*` tool; not exposed on OpenCode 2.
const V2_REDUNDANT_LEGACY_TOOLS = new Set(["get_goal", "set_goal"])

const NON_GOAL_AGENTS = new Set(["title", "compaction"])

function rememberChild(host, data) {
  const parentID = data?.parentID
  const sessionID = data?.sessionID
  if (typeof parentID !== "string" || !parentID || typeof sessionID !== "string" || !sessionID) return
  let children = host.children.get(parentID)
  if (!children) {
    children = new Set()
    host.children.set(parentID, children)
  }
  children.add(sessionID)
}

function forgetSession(host, sessionID) {
  if (!sessionID) return
  host.statuses.delete(sessionID)
  host.lastPromptMessageIDs.delete(sessionID)
  host.children.delete(sessionID)
  for (const [parentID, children] of host.children) {
    if (children.delete(sessionID) && children.size === 0) host.children.delete(parentID)
  }
}

/**
 * Translate one V2 server event into the V1 event shape the plugin's event
 * hook consumes. Returns `null` for events with no V1 counterpart the plugin
 * cares about. V2 changed both event names and payload location (`data`
 * instead of `properties`), and several V1 events no longer exist at all:
 *
 *   session.execution.succeeded -> session.idle      (auto-continue driver)
 *   session.execution.failed    -> session.error     (provider error pause)
 *   session.execution.interrupted -> session.error   (user interrupt pause)
 *   session.compaction.ended    -> session.compacted (context epoch)
 *   session.step.ended/failed   -> message.updated   (usage + progress)
 *   session.agent/model.selected -> session.updated  (execution context)
 */
export function toV1Event(event, host = createHostState()) {
  if (!isPlainObject(event) || typeof event.type !== "string") return null
  const data = isPlainObject(event.data) ? event.data : {}
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : ""
  const id = typeof event.id === "string" ? event.id : ""

  switch (event.type) {
    case "session.status": {
      if (sessionID && isPlainObject(data.status)) host.statuses.set(sessionID, data.status)
      return { id, type: "session.status", properties: { sessionID, status: data.status } }
    }

    case "session.idle": {
      if (sessionID) host.statuses.set(sessionID, { type: "idle" })
      return { id, type: "session.idle", properties: { sessionID } }
    }

    case "session.execution.started": {
      if (sessionID) host.statuses.set(sessionID, { type: "busy" })
      // Forward as V1 `session.status`: the plugin records host status from
      // that event, and without a busy transition a session that is running
      // still reads as idle to the child-wake guard.
      return { id, type: "session.status", properties: { sessionID, status: { type: "busy" } } }
    }

    case "session.execution.succeeded": {
      if (sessionID) host.statuses.set(sessionID, { type: "idle" })
      // The V1 driver event. Give it a unique id so the plugin's idle-event
      // dedup cannot swallow a later, genuinely different idle.
      return { id: id ? `${id}:idle` : "", type: "session.idle", properties: { sessionID } }
    }

    case "session.execution.interrupted": {
      if (sessionID) host.statuses.set(sessionID, { type: "idle" })
      return {
        id,
        type: "session.error",
        properties: {
          sessionID,
          error: { name: "MessageAbortedError", message: String(data.reason || "interrupted") },
        },
      }
    }

    case "session.execution.failed": {
      if (sessionID) host.statuses.set(sessionID, { type: "idle" })
      const error = isPlainObject(data.error) ? data.error : {}
      return {
        id,
        type: "session.error",
        properties: {
          sessionID,
          error: { name: String(error.type || "ProviderError"), message: String(error.message || "") },
        },
      }
    }

    case "session.compaction.ended": {
      // `id` is the compaction identity the plugin dedups on.
      return { id, type: "session.compacted", properties: { sessionID } }
    }

    case "session.agent.selected": {
      return {
        id,
        type: "session.updated",
        properties: { sessionID, info: { sessionID, agent: data.agent } },
      }
    }

    case "session.model.selected": {
      return {
        id,
        type: "session.updated",
        properties: { sessionID, info: { sessionID, model: data.model } },
      }
    }

    case "session.created": {
      rememberChild(host, data)
      if (sessionID && (data.agent || data.title)) {
        return {
          id,
          type: "session.updated",
          properties: {
            sessionID,
            info: { sessionID, ...(data.agent ? { agent: data.agent } : {}), ...(data.title ? { title: data.title } : {}) },
          },
        }
      }
      return null
    }

    case "session.deleted": {
      forgetSession(host, sessionID)
      return null
    }

    case "permission.replied": {
      return { id, type: "permission.replied", properties: { ...data, sessionID } }
    }

    case "session.step.started": {
      if (data.assistantMessageID && typeof data.agent === "string") {
        host.assistantAgents.set(data.assistantMessageID, data.agent)
        if (host.assistantAgents.size > 512) {
          host.assistantAgents.delete(host.assistantAgents.keys().next().value)
        }
      }
      return null
    }

    case "session.step.ended":
    case "session.step.failed": {
      const messageID = data.assistantMessageID
      if (!messageID || !sessionID) return null
      const agent = host.assistantAgents.get(messageID) || ""
      host.assistantAgents.delete(messageID)
      // Title and compaction model runs are host bookkeeping, not goal work:
      // charging them to the goal budget (or pausing on their failure) would
      // corrupt the run the same way V1's own filters did.
      if (agent && NON_GOAL_AGENTS.has(agent)) return null
      const info = {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: host.lastPromptMessageIDs.get(sessionID) || "",
        ...(agent ? { agent } : {}),
        ...(isPlainObject(data.tokens) ? { tokens: data.tokens } : {}),
        ...(typeof data.cost === "number" ? { cost: data.cost } : {}),
      }
      // A failed step is not necessarily a failed run: V2 retries retryable
      // step errors, and pausing the goal on the first one would stop work the
      // host is still recovering from. Terminal provider failures surface as
      // `session.execution.failed`, which this bridge maps to V1
      // `session.error` (the plugin's terminal-error pause).
      return { id, type: "message.updated", properties: { sessionID, info } }
    }

    default:
      return null
  }
}

/* ------------------------------------------------------------------ *
 * V2 session client
 * ------------------------------------------------------------------ */

// The host may add its own rules to every agent (OpenCode 2.0.26 appends a
// `browser` deny). Accept the owned rules in order with extra rules mixed in
// only when every extra rule is a deny: a deny can never widen access under
// either first- or last-match evaluation, while any extra allow or ask can.
function permissionsOnlyNarrow(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false
  const same = (a, b) =>
    isPlainObject(a) && a.action === b.action && a.resource === b.resource && a.effect === b.effect
  let next = 0
  for (const rule of actual) {
    if (next < expected.length && same(rule, expected[next])) next += 1
    else if (rule?.effect !== "deny") return false
  }
  return next === expected.length
}

async function assertVerifierOwnership(ctx, name) {
  if (typeof ctx.agent?.get !== "function") throw new Error("verifier agent lookup unavailable")
  const actual = unwrap(await ctx.agent.get({ agentID: name }))
  const config = applyNativeGoalConfig({}, { verifierAgentName: name, goalAgentName: name === "goal" ? "goal-work" : "goal" })
  const expected = translateV1Agent(name, config.agent[name])
  if (!actual || actual.system !== expected.system ||
      !permissionsOnlyNarrow(actual.permissions, expected.permissions)) {
    throw new Error(`completionAudit cannot safely use agent ${JSON.stringify(name)}; verifier ownership or permissions were not confirmed`)
  }
}

/**
 * Present V2's `ctx.session` domain through the session SDK contract the
 * plugin already uses. `createOpenCodeSessionApi` prefers the flat input
 * shape, so every method accepts `{ sessionID, ... }` (a legacy `{path,
 * query}` input is tolerated for read-only operations).
 */
export function createV2Client(ctx, host = createHostState(), options = ctx.options || {}) {
  const session = ctx.session

  const submitPrompt = async (input = {}) => {
    const sessionID = sessionIDOf(input)
    if (!sessionID) return { error: { name: "Error", message: "session id unavailable" } }

    // V1 carried an explicit agent/model on plugin prompts (the auditor pins
    // the verifier agent; continuations keep the originating agent). V2 has no
    // prompt-level agent field, so switch the session first — the same thing
    // V2's own command runner does.
    if (typeof input.agent === "string" && input.agent.trim()) {
      const agent = input.agent.trim()
      if (options.completionAudit && agent === (options.verifierAgentName || "goal-verify")) {
        await assertVerifierOwnership(ctx, agent)
      }
      await session.switchAgent({ sessionID, agent })
    }

    const parts = Array.isArray(input.parts) ? input.parts : []
    const text = parts.length
      ? textFromParts(parts) || String(input.text || "")
      : String(input.text || "")
    const marker =
      parts.map((part) => part?.metadata?.[MARKER_KEY]).find(isPlainObject) ||
      (isPlainObject(input.metadata?.[MARKER_KEY]) ? input.metadata[MARKER_KEY] : null)

    const payload = { sessionID, text }
    if (Array.isArray(input.files) && input.files.length) payload.files = input.files
    if (marker) payload.metadata = { [MARKER_KEY]: marker }
    if (isPlainObject(input.metadata)) {
      payload.metadata = { ...input.metadata, ...(marker ? { [MARKER_KEY]: marker } : {}) }
    }
    return await session.prompt(payload)
  }

  return {
    app: {},
    session: {
      async messages(input) {
        const sessionID = sessionIDOf(input)
        if (!sessionID) return []
        const raw = await session.context({ sessionID })
        const list = normalizeMessageList(raw, sessionID)
        const limit = Number(
          isPlainObject(input) && isPlainObject(input.query)
            ? input.query.limit
            : isPlainObject(input)
              ? input.limit
              : undefined,
        )
        return Number.isFinite(limit) && limit > 0 ? list.slice(-limit) : list
      },
      async promptAsync(input) {
        try {
          return await submitPrompt(input)
        } catch (error) {
          // V1's SDK resolved `{error}` instead of rejecting; the goal loop
          // counts prompt failures from that shape.
          return { error: toErrorInfo(error) }
        }
      },
      async prompt(input) {
        try {
          const admitted = await submitPrompt(input)
          if (admitted?.error) return admitted
          // V2 prompt returns an admission receipt, not the assistant reply.
          // The synchronous V1 contract must wait before reading the verdict.
          if (typeof session.wait === "function") {
            const sessionID = sessionIDOf(input)
            await session.wait({ sessionID })
            const messages = normalizeMessageList(await session.context({ sessionID }), sessionID)
            const assistant = [...messages].reverse().find(message => message.info?.role === "assistant" || message.role === "assistant")
            return assistant ? { parts: assistant.parts } : admitted
          }
          return admitted
        } catch (error) {
          return { error: toErrorInfo(error) }
        }
      },
      async create(input = {}) {
        const { parentID, ...rest } = isPlainObject(input) ? input : {}
        const metadata = { ...(isPlainObject(rest.metadata) ? rest.metadata : {}) }
        if (typeof parentID === "string" && parentID) {
          // V2's public create API has no parentID field. Record the link in
          // session metadata so the relationship is durable and reportable,
          // then echo it back on the created record.
          metadata[MARKER_KEY] = {
            ...(isPlainObject(metadata[MARKER_KEY]) ? metadata[MARKER_KEY] : {}),
            parentSessionID: parentID,
          }
        }
        const created = unwrap(await session.create({ ...rest, metadata }))
        if (typeof parentID !== "string" || !parentID) return created
        return isPlainObject(created) ? { ...created, parentID: created.parentID || parentID } : created
      },
      async get(input) {
        return await session.get({ sessionID: sessionIDOf(input) })
      },
      async update(input) {
        const payload = { sessionID: sessionIDOf(input) }
        if (isPlainObject(input)) {
          if (typeof input.title === "string") payload.title = input.title
          if (isPlainObject(input.metadata)) payload.metadata = input.metadata
        }
        return await session.update(payload)
      },
      async abort(input) {
        return await session.interrupt({ sessionID: sessionIDOf(input), resume: false })
      },
      async children(input) {
        const parentID = sessionIDOf(input)
        const known = host.children.get(parentID)
        if (known && known.size) return [...known].map((id) => ({ id }))
        // Prefer a live query when the host exposes it; otherwise fall back to
        // the event-observed map. Both fail open (no children) when unknown.
        if (typeof session.list === "function") {
          try {
            const listed = unwrap(await session.list({ parentID }))
            if (Array.isArray(listed)) return listed
          } catch {
            // fall through to the observed map
          }
        }
        return []
      },
      async status() {
        if (typeof session.active === "function") {
          try {
            const active = unwrap(await session.active())
            if (isPlainObject(active)) {
              const statuses = {}
              for (const [id, value] of Object.entries(active)) {
                statuses[id] = isPlainObject(value?.status) ? value.status : value
              }
              return statuses
            }
          } catch {
            // fall through to observed statuses
          }
        }
        return Object.fromEntries(host.statuses)
      },
      ...(typeof session.remove === "function"
        ? {
            async delete(input) {
              return await session.remove({ sessionID: sessionIDOf(input) })
            },
          }
        : {}),
    },
  }
}

/* ------------------------------------------------------------------ *
 * V1 permission/config translation
 * ------------------------------------------------------------------ */

export function v1PermissionsToRules(permission) {
  if (!isPlainObject(permission)) return []
  const entries = Object.entries(permission).filter(
    ([, effect]) => effect === "allow" || effect === "deny" || effect === "ask",
  )
  const wildcard = entries.filter(([action]) => action === "*")
  const specific = entries.filter(([action]) => action !== "*")
  const rules = []
  for (const [action, effect] of [...wildcard, ...specific]) {
    // V2 evaluates rules in order and the last match wins, so the V1 wildcard
    // catch-all is emitted first and specific actions after it. Renamed V2
    // actions are emitted alongside their V1 spelling so a legacy name keeps
    // working whether or not the host still recognizes it.
    for (const name of [action, ...(AGENT_ALIAS_ACTIONS[action] || [])]) {
      rules.push({ action: name, resource: "*", effect })
    }
  }
  return rules
}

export function v1ToolsToRules(tools) {
  if (!isPlainObject(tools)) return []
  const rules = []
  for (const [name, enabled] of Object.entries(tools)) {
    if (enabled !== false) continue
    for (const action of [name, ...(AGENT_ALIAS_ACTIONS[name] || [])]) {
      rules.push({ action, resource: "*", effect: "deny" })
    }
  }
  return rules
}

/** Translate a V1 config agent definition into a V2 `Agent.Info` patch. */
export function translateV1Agent(id, definition) {
  const agent = { id, name: id }
  if (typeof definition.description === "string") agent.description = definition.description
  if (typeof definition.prompt === "string") agent.system = definition.prompt
  if (definition.mode === "subagent" || definition.mode === "primary" || definition.mode === "all") {
    agent.mode = definition.mode
  }
  if (typeof definition.hidden === "boolean") agent.hidden = definition.hidden
  const permissions = [
    ...v1PermissionsToRules(definition.permission),
    ...v1ToolsToRules(definition.tools),
  ]
  if (permissions.length) agent.permissions = permissions
  return agent
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

/** Mirrors the plugin's `commandName` normalization (leading slash stripped). */
export function normalizeCommandName(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim().replace(/^\/+/, "").trim() : ""
  return raw || "goal"
}

/**
 * Build the V2 `setup(ctx)` entrypoint around the plugin's V1 factory.
 *
 * @param {(context: {client: unknown, directory?: string}, options: object) => Promise<object>} goalPluginFactory
 */
export function createV2Setup(goalPluginFactory) {
  const setupInstance = async function setup(ctx) {
    const host = createHostState()
    const directory = ctx?.location?.directory || process.cwd()
    // V2's session API only speaks the flat argument shape; the compatibility
    // adapter probes the legacy generated-client shape otherwise.
    const options = { ...(isPlainObject(ctx?.options) ? ctx.options : {}), sdkShape: "flat" }
    const client = createV2Client(ctx, host, options)
    const hooks = await goalPluginFactory({ client, directory }, options)

    const registrations = []
    const track = async (registration) => {
      registrations.push(registration)
      return registration
    }

    const hookError = (where, error) => {
      logError(`OpenCode 2 ${where} hook failed`, error?.stack || error?.message || error)
    }

    /* ---------------- prompt hook (V1 `chat.message`) ---------------- */

    const onPrompt = async (event) => {
      const sessionID = event.sessionID
      if (typeof sessionID !== "string" || !sessionID) return
      if (typeof event.messageID === "string" && event.messageID) {
        host.lastPromptMessageIDs.set(sessionID, event.messageID)
      }
      const prompt = isPlainObject(event.prompt) ? event.prompt : {}
      const text = typeof prompt.text === "string" ? prompt.text : ""
      const files = Array.isArray(prompt.files) ? prompt.files : []
      const marker = isPlainObject(event.metadata?.[MARKER_KEY]) ? event.metadata[MARKER_KEY] : null

      const parts = []
      const textPart = { type: "text", text, messageID: event.messageID, sessionID }
      if (marker) {
        textPart.synthetic = true
        textPart.metadata = { [MARKER_KEY]: marker }
      }
      parts.push(textPart)
      for (const file of files) {
        if (!isPlainObject(file)) continue
        parts.push({ type: "file", uri: file.uri, name: file.name, messageID: event.messageID, sessionID })
      }
      // The V1 hook builds `message.info = output.message`, so `output.message`
      // must be the flat message-info record, not a wrapper around one:
      // `messageID()` reads `message.info.id`, and command-turn correlation
      // (plus every later ownership check) depends on it being non-empty.
      const info = { id: event.messageID, role: "user", sessionID }
      const output = { message: info, parts }

      if (typeof hooks["chat.message"] !== "function") return
      try {
        await hooks["chat.message"]({ sessionID, messageID: event.messageID }, output)
      } catch (error) {
        hookError("chat.message", error)
        return
      }

      const rewritten = textFromParts(output.parts)
      if (rewritten !== text) event.prompt.text = rewritten

      const retained = new Set(
        output.parts.filter((part) => part?.type === "file" && part.uri).map((part) => part.uri),
      )
      if (files.length && retained.size !== files.length) {
        event.prompt.files = files.filter((file) => retained.has(file.uri))
      }

      const marked = output.parts.find(
        (part) => part?.type === "text" && isPlainObject(part?.metadata?.[MARKER_KEY]),
      )
      if (marked) {
        event.metadata = {
          ...(isPlainObject(event.metadata) ? event.metadata : {}),
          [MARKER_KEY]: marked.metadata[MARKER_KEY],
        }
      }
    }

    await track(await ctx.session.hook("prompt", onPrompt))

    /* ---------------- context hooks ---------------- */

    // V1 `chat.params`: remembers the agent/model driving this request, which
    // the planning-only restriction depends on.
    await track(
      await ctx.session.hook("context", async (event) => {
        if (typeof hooks["chat.params"] !== "function") return
        try {
          await hooks["chat.params"]({
            sessionID: event.sessionID,
            agent: event.agent,
            model: event.model,
            variant: event.model?.variant,
          })
        } catch (error) {
          hookError("chat.params", error)
        }
      }),
    )

    // V1 `experimental.chat.system.transform`: injects the goal block into the
    // system prompt of every model request.
    await track(
      await ctx.session.hook("context", async (event) => {
        if (typeof hooks["experimental.chat.system.transform"] !== "function") return
        const output = { system: Array.isArray(event.system) ? [...event.system] : [] }
        try {
          await hooks["experimental.chat.system.transform"]({ sessionID: event.sessionID }, output)
        } catch (error) {
          hookError("experimental.chat.system.transform", error)
          return
        }
        if (Array.isArray(output.system)) event.system = output.system.map(toSystemPart)
      }),
    )

    /* ---------------- compaction hook ---------------- */

    // V1 `experimental.session.compacting`: keeps the goal block in the
    // summarizer's context so a compaction cannot drop the objective.
    await track(
      await ctx.session.hook("compaction", async (event) => {
        if (typeof hooks["experimental.session.compacting"] !== "function") return
        const output = { context: [] }
        try {
          await hooks["experimental.session.compacting"]({ sessionID: event.sessionID }, output)
        } catch (error) {
          hookError("experimental.session.compacting", error)
          return
        }
        const entries = Array.isArray(output.context) ? output.context : []
        const additions = entries
          .map((entry) =>
            typeof entry === "string"
              ? { type: "text", text: entry }
              : isPlainObject(entry) && typeof entry.text === "string"
                ? { type: "text", text: entry.text }
                : null,
          )
          .filter(Boolean)
        if (additions.length) event.system = [...(event.system || []), ...additions]
      }),
    )

    /* ---------------- tool execution guard ---------------- */

    // V1 `tool.execute.before` throws to block tools while a handled control
    // command result is being reported; the throw is the contract here too.
    if (typeof hooks["tool.execute.before"] === "function") {
      await track(
        await ctx.tool.hook("execute.before", async (event) => {
          await hooks["tool.execute.before"]({
            sessionID: event.sessionID,
            tool: event.tool,
            input: event.input,
            agent: event.agent,
          })
        }),
      )
    }

    /* ---------------- agent-facing goal tools ---------------- */

    if (isPlainObject(hooks.tool)) {
      // OpenCode 2 lists tools by name for the model to discover, and two
      // spellings of the same operation invite invented hybrids such as
      // `get_goal_status`. Drop the V1 aliases that have a canonical twin;
      // `get_goal_history`, `update_goal` and `clear_goal` have none and stay.
      const definitions = Object.entries(hooks.tool).filter(
        ([name, definition]) =>
          !V2_REDUNDANT_LEGACY_TOOLS.has(name) &&
          isPlainObject(definition) &&
          typeof definition.execute === "function",
      )
      if (definitions.length) {
        await track(
          await ctx.tool.transform((editor) => {
            for (const [name, definition] of definitions) {
              editor.add({
                name,
                description: definition.description || "",
                // Zod v4 schemas are Standard Schema v1, which V2 accepts
                // directly and converts to JSON Schema itself.
                input: z.object(isPlainObject(definition.args) ? definition.args : {}),
                execute: async (input, context) => {
                  const result = await definition.execute(input, context)
                  return typeof result === "string" ? { content: result } : result
                },
              })
            }
          }),
        )
      }
    }

    /* ---------------- native goal agents ---------------- */

    const registerAgents = options.registerAgents !== false
    const completionAudit = options.completionAudit === true
    const verifierAgentName = options.verifierAgentName || "goal-verify"
    let configValidated = false

    const validateConfig = async () => {
      if (configValidated) return
      configValidated = true
      const config = { agent: {} }
      await hooks.config(config)
      return config
    }

    if (registerAgents) {
      // Validate before registering so a bad agent-name configuration fails
      // setup, exactly as the V1 config hook did.
      const config = await validateConfig()
      const agents = isPlainObject(config.agent) ? config.agent : {}
      const entries = Object.entries(agents)
      if (entries.length) {
        await track(
          await ctx.agent.transform((editor) => {
            for (const [id, definition] of entries) {
              // V1 used `||=`: an agent that already exists is never
              // overwritten by the plugin. A user-configured agent of the
              // same name is registered after this transform and therefore
              // also wins, matching the V1 config-hook semantics.
              if (editor.get(id)) continue
              editor.update(id, (agent) => Object.assign(agent, translateV1Agent(id, definition)))
            }
          }),
        )
      }
    } else {
      await validateConfig()
    }

    /* ---------------- slash command ---------------- */

    const registerCommand = typeof hooks["command.execute.before"] === "function"
    const commandName = normalizeCommandName(options.commandName)
    let commandReasserts = 0
    let ownershipWarned = false

    const commandDefinition = {
      name: commandName,
      description: GOAL_COMMAND_DESCRIPTION,
      execute: async (invocation) => {
        const sessionID = invocation?.sessionID
        if (!sessionID) return
        const prompt = isPlainObject(invocation.prompt) ? invocation.prompt : {}
        const files = Array.isArray(prompt.files) ? prompt.files : []
        const output = {
          parts: files
            .filter(isPlainObject)
            .map((file) => ({ type: "file", uri: file.uri, name: file.name })),
        }
        const input = {
          command: commandDefinition.name,
          sessionID,
          arguments: typeof prompt.text === "string" ? prompt.text : "",
        }
        await hooks["command.execute.before"](input, output)

        const marked = output.parts.find(
          (part) => part?.type === "text" && isPlainObject(part?.metadata?.[MARKER_KEY]),
        )
        if (!marked) return
        const retained = new Set(
          output.parts.filter((part) => part?.type === "file" && part.uri).map((part) => part.uri),
        )
        const payload = {
          sessionID,
          text: String(marked.text || ""),
          metadata: { [MARKER_KEY]: marked.metadata[MARKER_KEY] },
          ...(files.length ? { files: files.filter((file) => retained.has(file.uri)) } : {}),
          ...(typeof invocation.delivery === "string" ? { delivery: invocation.delivery } : {}),
        }
        await ctx.session.prompt(payload)
      },
    }

    if (registerCommand) {
      await track(await ctx.command.transform((editor) => editor.add(commandDefinition)))
    }

    /* ---------------- event stream ---------------- */

    const controller = new AbortController()
    const consumeEvents = async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (host.disposed) return
          if (!eventBelongsToLocation(event, directory)) continue
          if (
            (event?.type === "command.updated" || event?.type === "config.updated") &&
            registerCommand
          ) {
            scheduleCommandOwnershipCheck()
          }
          let normalized
          try {
            normalized = toV1Event(event, host)
          } catch (error) {
            hookError("event normalization", error)
            continue
          }
          if (!normalized) continue
          try {
            await hooks.event({ event: normalized })
          } catch (error) {
            hookError("event", error)
          }
        }
      } catch (error) {
        if (!host.disposed && !controller.signal.aborted) hookError("event subscription", error)
      }
    }
    void consumeEvents()

    /* ---------------- deferred host-activation work ---------------- */

    const timers = new Set()
    const later = (fn, delay) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!host.disposed) void fn().catch((error) => hookError("deferred activation", error))
      }, delay)
      if (typeof timer.unref === "function") timer.unref()
      timers.add(timer)
      return timer
    }

    const listCommands = async () => {
      if (typeof ctx.command.list !== "function") return []
      const listed = await ctx.command.list()
      if (Array.isArray(listed)) return listed
      if (Array.isArray(listed?.data)) return listed.data
      return []
    }

    // V2 registers config `command` entries after user plugins, so a legacy
    // `command.<name>` entry in opencode.json would otherwise shadow the
    // plugin's handler. Re-asserting the plugin's registration after host
    // activation puts it last in registration order (last write wins) and
    // verifies that the plugin actually owns the command.
    const checkCommandOwnership = async () => {
      if (!registerCommand || host.disposed) return
      let info
      try {
        info = (await listCommands()).find((entry) => entry?.name === commandDefinition.name)
      } catch (error) {
        hookError("command ownership check", error)
        return
      }
      if (!info) return
      if (info.description === GOAL_COMMAND_DESCRIPTION) return
      if (commandReasserts >= 3) {
        if (!ownershipWarned) {
          ownershipWarned = true
          logWarn(
            `A config command ${JSON.stringify(commandDefinition.name)} is shadowing the goal plugin's handler. ` +
              `Remove the ${JSON.stringify(commandDefinition.name)} entry from \`command\`/\`commands\` in opencode.json so the plugin can own it.`,
          )
        }
        return
      }
      commandReasserts += 1
      await ctx.command.transform((editor) => editor.add(commandDefinition))
      later(checkCommandOwnership, 500)
    }

    const scheduleCommandOwnershipCheck = () => {
      if (host.disposed || !registerCommand) return
      later(checkCommandOwnership, 1000)
    }

    // V2 registers internal (config) plugins after this setup returns, so the
    // first ownership check must wait for activation to finish.
    if (registerCommand) later(checkCommandOwnership, 2000)

    if (completionAudit && registerAgents) {
      later(async () => {
        if (host.disposed) return
        // Confirm the verifier agent this plugin created was not replaced by
        // a user-configured agent of the same name. The V1 config hook threw
        // in that case; V2 cannot fail startup from a deferred task, so the
        // conflict is raised through the same hook instead: seeding the
        // verifier name makes `requireVerifierOwnership` throw, which leaves
        // `verifierRegistrationReady` false and fails audits closed.
        const config = { agent: {} }
        try {
          try {
            await assertVerifierOwnership(ctx, verifierAgentName)
          } catch {
            config.agent[verifierAgentName] = {}
          }
          await hooks.config(config)
        } catch (error) {
          logError(
            `completionAudit cannot safely use agent ${JSON.stringify(verifierAgentName)}; ` +
              `choose an unused verifierAgentName. Completion audits are disabled for this session.`,
            error?.message || error,
          )
        }
      }, 2000)
    }

    /* ---------------- cleanup ---------------- */

    let disposePromise
    return () => disposePromise ||= (async () => {
      host.disposed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      controller.abort()
      for (const registration of [...registrations].reverse()) {
        try {
          await registration.dispose()
        } catch {
          // Disposal is best-effort; registrations are also disposed on unload.
        }
      }
      try {
        await hooks.dispose()
      } catch (error) {
        hookError("dispose", error)
      }
    })()
  }
  return async function setup(ctx) {
    // Host reloads can omit cleanup. Retire the old same-location instance
    // explicitly; never infer abandonment from age. Survive module reloads.
    const slot = Symbol.for("opencode-goal-plugin.v2-setups")
    const instances = globalThis[slot] ||= new Map()
    const key = normalizeDirectory(ctx?.location?.directory || process.cwd())
    const previous = instances.get(key)
    let resolveReady
    const ready = new Promise(resolve => { resolveReady = resolve })
    instances.set(key, ready)
    try {
      const disposePrevious = await previous
      if (disposePrevious) await disposePrevious()
      const dispose = await setupInstance(ctx)
      const cleanup = async () => {
        await dispose()
        if (instances.get(key) === ready) instances.delete(key)
      }
      resolveReady(cleanup)
      return cleanup
    } catch (error) {
      resolveReady(undefined)
      if (instances.get(key) === ready) instances.delete(key)
      throw error
    }
  }
}

function toSystemPart(entry) {
  if (typeof entry === "string") return { type: "text", text: entry }
  if (!isPlainObject(entry)) return { type: "text", text: "" }
  if (typeof entry.text === "string") return { ...entry, type: entry.type || "text" }
  if (typeof entry.content === "string") return { ...entry, type: "text", text: entry.content }
  return { type: entry.type || "text", text: "" }
}

export const v2BridgeInternals = Object.freeze({
  MARKER_KEY,
  GOAL_COMMAND_DESCRIPTION,
  createHostState,
  createV2Client,
  eventBelongsToLocation,
  normalizeCommandName,
  normalizeMessage,
  normalizeMessageList,
  textFromParts,
  toErrorInfo,
  toSystemPart,
  toV1Event,
  translateV1Agent,
  unwrap,
  v1PermissionsToRules,
  v1ToolsToRules,
})
