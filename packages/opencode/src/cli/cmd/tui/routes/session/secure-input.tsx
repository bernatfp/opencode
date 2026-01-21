import { createSignal, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useKeybind } from "../../context/keybind"
import { useTheme } from "../../context/theme"
import type { SecureInputRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../component/border"

export function SecureInputPrompt(props: { request: SecureInputRequest }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dimensions = useTerminalDimensions()
  const narrow = () => dimensions().width < 80

  const [password, setPassword] = createSignal("")

  const submit = () => {
    const value = password()
    if (!value) return

    // Submit the secure input - goes directly to PTY
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

  useKeyboard((evt) => {
    // Handle escape to cancel
    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      cancel()
      return
    }

    // Handle enter to submit
    if (evt.name === "return") {
      evt.preventDefault()
      submit()
      return
    }

    // Handle backspace
    if (evt.name === "backspace") {
      evt.preventDefault()
      setPassword((prev) => prev.slice(0, -1))
      return
    }

    // Handle delete (clear all)
    if (evt.name === "delete" && evt.ctrl) {
      evt.preventDefault()
      setPassword("")
      return
    }

    // Handle printable characters
    if (evt.char && evt.char.length === 1 && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      setPassword((prev) => prev + evt.char)
    }
  })

  // Display masked password (asterisks)
  const maskedPassword = () => {
    const len = password().length
    if (len === 0) return ""
    return "*".repeat(len)
  }

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SplitBorder.customBorderChars}
    >
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
