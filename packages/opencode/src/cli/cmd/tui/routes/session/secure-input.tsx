import { createSignal, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useKeybind } from "../../context/keybind"
import { useTheme } from "../../context/theme"
import type { SecureInputRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../component/border"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"

export function SecureInputPrompt(props: { request: SecureInputRequest }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const bindings = useTextareaKeybindings()
  const dimensions = useTerminalDimensions()
  const narrow = () => dimensions().width < 80

  let textarea: TextareaRenderable | undefined
  const [inputValue, setInputValue] = createSignal("")

  const submit = () => {
    const value = textarea?.plainText ?? inputValue()
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
    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      cancel()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      submit()
    }
  })

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
        <textarea
          ref={(val: TextareaRenderable) => {
            textarea = val
            queueMicrotask(() => {
              val.focus()
            })
          }}
          focused
          password={true}
          placeholder="Enter password..."
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
          keyBindings={bindings()}
          onInput={(e: { plainText: string }) => setInputValue(e.plainText)}
        />
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
