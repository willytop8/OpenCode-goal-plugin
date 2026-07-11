const SHAPE_ERROR_PATTERNS = [
  /(?:missing|required).*(?:sessionID|path|body|query)/i,
  /(?:unknown|unrecognized|unexpected|invalid).*(?:sessionID|path|body|query|argument|field|key)/i,
  /(?:expected|must be).*(?:object|path|body|query|sessionID)/i,
  /(?:validation|schema|invalid input|invalid argument)/i,
]

// Only read-only operations may be retried with another argument shape. A
// TypeError can be raised after a mutating SDK call has already reached the
// host, so replaying create/prompt/update/delete/abort could duplicate side effects.
const REPLAY_SAFE_OPERATIONS = new Set(["messages", "get"])

function isArgumentShapeError(error) {
  if (!(error instanceof TypeError)) return false
  const message = String(error.message || "")
  return SHAPE_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

function unwrapData(response) {
  return response && typeof response === "object" && "data" in response
    ? response.data
    : response
}

/**
 * Present both historical and current OpenCode session SDKs through one API.
 * A successful shape is remembered independently for every operation.
 */
export function createOpenCodeSessionApi(client, options = {}) {
  if (!client?.session || typeof client.session !== "object") {
    throw new TypeError("OpenCode client.session is required")
  }

  const preferredShape = options.preferredShape || "flat"
  if (preferredShape !== "flat" && preferredShape !== "legacy") {
    throw new TypeError('preferredShape must be "flat" or "legacy"')
  }
  const shapes = new Map()

  async function invoke(operation, flatInput, legacyInput) {
    const method = client.session[operation]
    if (typeof method !== "function") {
      throw new TypeError(`OpenCode client.session.${operation} is not available`)
    }

    const knownShape = shapes.get(operation)
    const firstShape = knownShape || preferredShape
    const firstInput = firstShape === "flat" ? flatInput : legacyInput
    try {
      const response = await method.call(client.session, firstInput)
      shapes.set(operation, firstShape)
      return unwrapData(response)
    } catch (error) {
      if (knownShape || !REPLAY_SAFE_OPERATIONS.has(operation) || !isArgumentShapeError(error)) {
        throw error
      }
      const fallbackShape = firstShape === "flat" ? "legacy" : "flat"
      const fallbackInput = fallbackShape === "flat" ? flatInput : legacyInput
      const response = await method.call(client.session, fallbackInput)
      shapes.set(operation, fallbackShape)
      return unwrapData(response)
    }
  }

  return Object.freeze({
    messages(sessionID, options = {}) {
      return invoke(
        "messages",
        { sessionID, ...options },
        { path: { id: sessionID }, query: options },
      )
    },
    promptAsync(sessionID, input = {}) {
      return invoke(
        "promptAsync",
        { sessionID, ...input },
        { path: { id: sessionID }, body: input },
      )
    },
    createChild(parentID, input = {}) {
      const body = { ...input, parentID }
      return invoke("create", body, { body })
    },
    prompt(sessionID, input = {}) {
      return invoke(
        "prompt",
        { sessionID, ...input },
        { path: { id: sessionID }, body: input },
      )
    },
    update(sessionID, input = {}) {
      return invoke(
        "update",
        { sessionID, ...input },
        { path: { id: sessionID }, body: input },
      )
    },
    get(sessionID) {
      return invoke("get", { sessionID }, { path: { id: sessionID } })
    },
    delete(sessionID) {
      return invoke("delete", { sessionID }, { path: { id: sessionID } })
    },
    abort(sessionID) {
      return invoke("abort", { sessionID }, { path: { id: sessionID } })
    },
  })
}

export const sessionApiInternals = Object.freeze({ isArgumentShapeError, unwrapData })
