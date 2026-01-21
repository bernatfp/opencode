import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import z from "zod"
import type { IPty } from "bun-pty"

export namespace SecureInput {
  const log = Log.create({ service: "secure-input" })

  // Password prompt patterns for various tools
  const PASSWORD_PATTERNS = [
    /\[sudo\] password for .+:/i,
    /Password:/i,
    /Enter passphrase for .+:/i,
    /BECOME password:/i,
    /SSH password:/i,
    /passphrase:/i,
    /password for .+:/i,
    /\(yes\/no.*\)\?/i, // SSH host key confirmation
  ]

  // Commands that typically require interactive input
  const INTERACTIVE_COMMANDS = [
    /^sudo\s/,
    /\bsudo\s/,
    /^ssh\s.*-t\b/,
    /\bssh\s.*-t\b/,
    /^ansible\b.*-K\b/,
    /^ansible\b.*--ask-become-pass\b/,
    /^ansible-playbook\b.*-K\b/,
    /^ansible-playbook\b.*--ask-become-pass\b/,
    /^su\s/,
    /^gpg\s/,
    /\bsudo\b/,
  ]

  export const Request = z
    .object({
      id: Identifier.schema("secureinput"),
      sessionID: z.string(),
      prompt: z.string().describe("The password prompt text displayed to the user"),
      command: z.string().describe("The command that triggered this prompt"),
    })
    .meta({
      ref: "SecureInputRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Event = {
    Requested: BusEvent.define("secure-input.requested", Request),
    Submitted: BusEvent.define(
      "secure-input.submitted",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
    Cancelled: BusEvent.define(
      "secure-input.cancelled",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
    TimedOut: BusEvent.define(
      "secure-input.timed-out",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
  }

  interface PendingRequest {
    info: Request
    pty: IPty
    resolve: () => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
    retryCount: number
  }

  const state = Instance.state(async () => {
    const pending: Record<string, PendingRequest> = {}
    return { pending }
  })

  const DEFAULT_TIMEOUT = 60_000 // 60 seconds
  const MAX_RETRIES = 3

  /**
   * Check if a command likely requires interactive input
   */
  export function isInteractiveCommand(command: string): boolean {
    return INTERACTIVE_COMMANDS.some((pattern) => pattern.test(command))
  }

  /**
   * Check if output contains a password prompt
   */
  export function detectPasswordPrompt(output: string): string | null {
    for (const pattern of PASSWORD_PATTERNS) {
      const match = output.match(pattern)
      if (match) {
        return match[0]
      }
    }
    return null
  }

  /**
   * Request secure input from the user
   */
  export async function request(input: {
    sessionID: string
    prompt: string
    command: string
    pty: IPty
  }): Promise<void> {
    const s = await state()
    const id = Identifier.ascending("secureinput")

    // Check if there's already a pending request for this session
    const existingRequest = Object.values(s.pending).find(
      (req) => req.info.sessionID === input.sessionID,
    )
    if (existingRequest) {
      // Check retry count
      if (existingRequest.retryCount >= MAX_RETRIES) {
        throw new MaxRetriesError()
      }
    }

    log.info("requesting secure input", { id, prompt: input.prompt })

    return new Promise<void>((resolve, reject) => {
      const info: Request = {
        id,
        sessionID: input.sessionID,
        prompt: input.prompt,
        command: input.command,
      }

      const timeout = setTimeout(async () => {
        const req = s.pending[id]
        if (req) {
          delete s.pending[id]
          // Send Ctrl+C to cancel the prompt
          try {
            req.pty.write("\x03")
          } catch {}
          Bus.publish(Event.TimedOut, {
            sessionID: info.sessionID,
            requestID: id,
          })
          req.reject(new TimeoutError())
        }
      }, DEFAULT_TIMEOUT)

      s.pending[id] = {
        info,
        pty: input.pty,
        resolve,
        reject,
        timeout,
        retryCount: existingRequest ? existingRequest.retryCount + 1 : 0,
      }

      Bus.publish(Event.Requested, info)
    })
  }

  /**
   * Submit secure input (password) for a pending request
   * The password goes directly to the PTY and is never stored or logged
   */
  export async function submit(requestID: string, password: string): Promise<void> {
    const s = await state()
    const req = s.pending[requestID]
    if (!req) {
      log.warn("submit for unknown request", { requestID })
      return
    }

    clearTimeout(req.timeout)
    delete s.pending[requestID]

    log.info("secure input submitted", { requestID })

    // Write password directly to PTY followed by newline
    // This goes directly to the process, never stored
    try {
      req.pty.write(password + "\n")
    } catch (error) {
      req.reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    Bus.publish(Event.Submitted, {
      sessionID: req.info.sessionID,
      requestID,
    })

    req.resolve()
  }

  /**
   * Cancel a pending secure input request
   */
  export async function cancel(requestID: string): Promise<void> {
    const s = await state()
    const req = s.pending[requestID]
    if (!req) {
      log.warn("cancel for unknown request", { requestID })
      return
    }

    clearTimeout(req.timeout)
    delete s.pending[requestID]

    log.info("secure input cancelled", { requestID })

    // Send Ctrl+C to cancel the prompt
    try {
      req.pty.write("\x03")
    } catch {}

    Bus.publish(Event.Cancelled, {
      sessionID: req.info.sessionID,
      requestID,
    })

    req.reject(new CancelledError())
  }

  /**
   * Get all pending secure input requests
   */
  export async function list(): Promise<Request[]> {
    const s = await state()
    return Object.values(s.pending).map((req) => req.info)
  }

  /**
   * Get pending requests for a specific session
   */
  export async function listForSession(sessionID: string): Promise<Request[]> {
    const s = await state()
    return Object.values(s.pending)
      .filter((req) => req.info.sessionID === sessionID)
      .map((req) => req.info)
  }

  /**
   * Sanitize output before sending to LLM
   * Replaces password prompts with placeholders
   */
  export function sanitizeOutput(output: string): string {
    let sanitized = output
    for (const pattern of PASSWORD_PATTERNS) {
      sanitized = sanitized.replace(
        pattern,
        "[Password prompt - user input required]",
      )
    }
    return sanitized
  }

  export class TimeoutError extends Error {
    constructor() {
      super("Secure input request timed out after 60 seconds")
      this.name = "SecureInputTimeoutError"
    }
  }

  export class CancelledError extends Error {
    constructor() {
      super("User cancelled the secure input request")
      this.name = "SecureInputCancelledError"
    }
  }

  export class MaxRetriesError extends Error {
    constructor() {
      super("Maximum password retry attempts exceeded (3)")
      this.name = "SecureInputMaxRetriesError"
    }
  }
}
