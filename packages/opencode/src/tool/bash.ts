import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language } from "web-tree-sitter"

import { $ } from "bun"
import { Filesystem } from "@/util/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag.ts"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { SecureInput } from "@/secure-input"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

const ptySpawn = lazy(async () => {
  const { spawn } = await import("bun-pty")
  return spawn
})

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  log.info("bash tool using shell", { shell })

  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
      interactive: z
        .boolean()
        .describe(
          "Set to true for commands that require password input (sudo, ssh -t, ansible -K). When enabled, the user will be prompted securely for passwords. Auto-detected for common patterns like 'sudo', 'ssh -t', 'ansible -K'.",
        )
        .optional(),
    }),
    async execute(params, ctx) {
      const cwd = params.workdir || Instance.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const tree = await parser().then((p) => p.parse(params.command))
      if (!tree) {
        throw new Error("Failed to parse command")
      }
      const directories = new Set<string>()
      if (!Instance.containsPath(cwd)) directories.add(cwd)
      const patterns = new Set<string>()
      const always = new Set<string>()

      for (const node of tree.rootNode.descendantsOfType("command")) {
        if (!node) continue
        const command = []
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)
          if (!child) continue
          if (
            child.type !== "command_name" &&
            child.type !== "word" &&
            child.type !== "string" &&
            child.type !== "raw_string" &&
            child.type !== "concatenation"
          ) {
            continue
          }
          command.push(child.text)
        }

        // not an exhaustive list, but covers most common cases
        if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown"].includes(command[0])) {
          for (const arg of command.slice(1)) {
            if (arg.startsWith("-") || (command[0] === "chmod" && arg.startsWith("+"))) continue
            const resolved = await $`realpath ${arg}`
              .cwd(cwd)
              .quiet()
              .nothrow()
              .text()
              .then((x) => x.trim())
            log.info("resolved path", { arg, resolved })
            if (resolved) {
              // Git Bash on Windows returns Unix-style paths like /c/Users/...
              const normalized =
                process.platform === "win32" && resolved.match(/^\/[a-z]\//)
                  ? resolved.replace(/^\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, "\\")
                  : resolved
              if (!Instance.containsPath(normalized)) directories.add(normalized)
            }
          }
        }

        // cd covered by above check
        if (command.length && command[0] !== "cd") {
          patterns.add(command.join(" "))
          always.add(BashArity.prefix(command).join(" ") + "*")
        }
      }

      if (directories.size > 0) {
        await ctx.ask({
          permission: "external_directory",
          patterns: Array.from(directories),
          always: Array.from(directories).map((x) => path.dirname(x) + "*"),
          metadata: {},
        })
      }

      if (patterns.size > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: Array.from(patterns),
          always: Array.from(always),
          metadata: {},
        })
      }

      // Determine if command needs interactive execution
      const needsInteractive = params.interactive ?? SecureInput.isInteractiveCommand(params.command)

      if (needsInteractive) {
        // Use PTY-based execution for interactive commands
        return await executeInteractive(params.command, cwd, timeout, params.description, ctx)
      }

      // Standard non-interactive execution
      const proc = spawn(params.command, {
        shell,
        cwd,
        env: {
          ...process.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })

      let output = ""

      // Initialize metadata with empty output
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      const append = (chunk: Buffer) => {
        output += chunk.toString()
        ctx.metadata({
          metadata: {
            // truncate the metadata to avoid GIANT blobs of data (has nothing to do w/ what agent can access)
            output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
            description: params.description,
          },
        })
      }

      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      let timedOut = false
      let aborted = false
      let exited = false

      const kill = () => Shell.killTree(proc, { exited: () => exited })

      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      const timeoutTimer = setTimeout(() => {
        timedOut = true
        void kill()
      }, timeout + 100)

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeoutTimer)
          ctx.abort.removeEventListener("abort", abortHandler)
        }

        proc.once("exit", () => {
          exited = true
          cleanup()
          resolve()
        })

        proc.once("error", (error) => {
          exited = true
          cleanup()
          reject(error)
        })
      })

      const resultMetadata: string[] = []

      if (timedOut) {
        resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (aborted) {
        resultMetadata.push("User aborted the command")
      }

      if (resultMetadata.length > 0) {
        output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
      }

      return {
        title: params.description,
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          exit: proc.exitCode,
          description: params.description,
        },
        output,
      }
    },
  }
})

/**
 * Execute a command interactively using PTY
 * Handles password prompts by requesting secure input from the user
 */
async function executeInteractive(
  command: string,
  cwd: string,
  timeout: number,
  description: string,
  ctx: Parameters<Parameters<typeof Tool.define>[1]>[1] extends Promise<infer U>
    ? U extends { execute: (params: any, ctx: infer C) => any }
      ? C
      : never
    : never,
): Promise<{ title: string; metadata: Record<string, unknown>; output: string }> {
  const shell = Shell.acceptable()
  const spawn = await ptySpawn()

  log.info("executing interactive command", { command, cwd })

  const ptyProcess = spawn(shell, ["-c", command], {
    name: "xterm-256color",
    cwd,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  })

  let output = ""
  let rawOutput = "" // Keep raw output for prompt detection
  let exitCode: number | null = null
  let timedOut = false
  let aborted = false
  let pendingPrompt = false

  // Initialize metadata with empty output
  ctx.metadata({
    metadata: {
      output: "",
      description,
      interactive: true,
    },
  })

  const updateMetadata = () => {
    // Sanitize output before sending to LLM - remove password prompts
    const sanitizedOutput = SecureInput.sanitizeOutput(output)
    ctx.metadata({
      metadata: {
        output:
          sanitizedOutput.length > MAX_METADATA_LENGTH
            ? sanitizedOutput.slice(0, MAX_METADATA_LENGTH) + "\n\n..."
            : sanitizedOutput,
        description,
        interactive: true,
      },
    })
  }

  // Buffer for detecting password prompts
  let promptBuffer = ""
  const PROMPT_BUFFER_SIZE = 500

  ptyProcess.onData((data: string) => {
    output += data
    rawOutput += data
    promptBuffer += data
    if (promptBuffer.length > PROMPT_BUFFER_SIZE) {
      promptBuffer = promptBuffer.slice(-PROMPT_BUFFER_SIZE)
    }

    updateMetadata()

    // Check for password prompt if we're not already handling one
    if (!pendingPrompt) {
      const prompt = SecureInput.detectPasswordPrompt(promptBuffer)
      if (prompt) {
        pendingPrompt = true
        log.info("detected password prompt", { prompt })

        // Request secure input from user
        SecureInput.request({
          sessionID: ctx.sessionID,
          prompt,
          command,
          pty: ptyProcess,
        })
          .then(() => {
            pendingPrompt = false
            promptBuffer = "" // Clear buffer after successful input
          })
          .catch((error) => {
            pendingPrompt = false
            log.warn("secure input failed", { error: error.message })
            // The error will be reflected in the command output
          })
      }
    }
  })

  const exitPromise = new Promise<number>((resolve) => {
    ptyProcess.onExit(({ exitCode: code }) => {
      exitCode = code
      resolve(code)
    })
  })

  // Handle abort
  const abortHandler = () => {
    aborted = true
    try {
      ptyProcess.write("\x03") // Send Ctrl+C
      setTimeout(() => {
        try {
          ptyProcess.kill()
        } catch {}
      }, 100)
    } catch {}
  }

  if (ctx.abort.aborted) {
    abortHandler()
  }

  ctx.abort.addEventListener("abort", abortHandler, { once: true })

  // Handle timeout
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    try {
      ptyProcess.write("\x03") // Send Ctrl+C
      setTimeout(() => {
        try {
          ptyProcess.kill()
        } catch {}
      }, 100)
    } catch {}
  }, timeout)

  try {
    await exitPromise
  } finally {
    clearTimeout(timeoutTimer)
    ctx.abort.removeEventListener("abort", abortHandler)
  }

  const resultMetadata: string[] = []

  if (timedOut) {
    resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
  }

  if (aborted) {
    resultMetadata.push("User aborted the command")
  }

  if (resultMetadata.length > 0) {
    output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
  }

  // Sanitize output - remove password prompts and any sensitive patterns
  const sanitizedOutput = SecureInput.sanitizeOutput(output)

  return {
    title: description,
    metadata: {
      output:
        sanitizedOutput.length > MAX_METADATA_LENGTH
          ? sanitizedOutput.slice(0, MAX_METADATA_LENGTH) + "\n\n..."
          : sanitizedOutput,
      exit: exitCode,
      description,
      interactive: true,
    },
    output: sanitizedOutput,
  }
}
