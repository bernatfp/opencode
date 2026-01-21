import { createSignal, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useKeybind } from "../../context/keybind"
import { useTheme } from "../../context/theme"
import type { SecureInputRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../component/border"
import { useDialog } from "../../ui/dialog"

export function SecureInputPrompt(props: { request: SecureInputRequest }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const narrow = () => dimensions().width < 80

  const [password, setPassword] = createSignal("")

  const submit = () => {
    const value = password()
    if (!value) return
    sdk.client.secureInput.submit({
      requestID: props.request.id,
      input: value,
    })
  }

  const cancel = () => {
    sdk.client.secureInput.cancel({
      requestID: props.request.id,
    })
  }

  // Handle ALL keyboard input manually
  useKeyboard((evt) => {
    // Skip if dialog is open (like command palette)
    if (dialog.stack.length > 0) return

    // Escape to cancel
    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      cancel()
      return
    }

    // Enter to submit
    if (evt.name === "return") {
      evt.preventDefault()
      submit()
      return
    }

    // Backspace to delete last character
    if (evt.name === "backspace") {
      evt.preventDefault()
      setPassword((prev) => prev.slice(0, -1))
      return
    }

    // Ctrl+U to clear all (common terminal shortcut)
    if (evt.name === "u" && evt.ctrl) {
      evt.preventDefault()
      setPassword("")
      return
    }

    // Printable characters: single character name, no ctrl/meta modifiers
    if (evt.name.length === 1 && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      setPassword((prev) => prev + evt.name)
      return
    }
  })

  // Display masked password
  const maskedPassword = () => "*".repeat(password().length)

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SplitBorder.customBorderChars}
    >
      {/* Header section */}
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={theme.accent}>{"🔐"}</text>
          <text fg={theme.text}>Secure Input Required</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>{props.request.prompt}</text>
        </box>
        <Show when={props.request.command}>
          <box paddingLeft={1}>
            <text fg={theme.textMuted}>
              Command: <span style={{ fg: theme.text }}>{props.request.command}</span>
            </text>
          </box>
        </Show>
      </box>

      {/* Input section */}
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={1}
      >
        <box flexDirection="row" flexGrow={1}>
          <text fg={theme.textMuted}>{"› "}</text>
          <text fg={theme.text}>
            {maskedPassword() || <span style={{ fg: theme.textMuted }}>Enter password...</span>}
          </text>
          <text fg={theme.primary}>{"█"}</text>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>submit</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>cancel</span>
          </text>
        </box>
      </box>
    </box>
  )
}
