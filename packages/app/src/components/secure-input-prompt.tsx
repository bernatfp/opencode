import { createSignal, Show } from "solid-js"
import type { SecureInputRequest } from "@opencode-ai/sdk/v2/client"
import { useData } from "@opencode-ai/ui/context/data"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"

interface SecureInputPromptProps {
  request: SecureInputRequest
  onSubmit?: () => void
  onCancel?: () => void
}

export function SecureInputPrompt(props: SecureInputPromptProps) {
  const data = useData()
  const language = useLanguage()
  const [inputValue, setInputValue] = createSignal("")
  const [isSubmitting, setIsSubmitting] = createSignal(false)

  const handleSubmit = () => {
    const value = inputValue()
    if (!value) return
    if (!data.submitSecureInput) return

    setIsSubmitting(true)
    data.submitSecureInput({
      requestID: props.request.id,
      input: value,
    })
    setInputValue("")
    props.onSubmit?.()
  }

  const handleCancel = () => {
    if (!data.cancelSecureInput) return

    data.cancelSecureInput({
      requestID: props.request.id,
    })
    setInputValue("")
    props.onCancel?.()
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      handleCancel()
    }
  }

  return (
    <div class="rounded-md border border-border-base bg-surface-base p-4">
      <div class="flex items-center gap-2 mb-3">
        <Icon name="lock" size="small" class="text-accent-primary" />
        <span class="text-14-medium text-text-strong">
          {language.t("secureInput.title", { fallback: "Secure Input Required" })}
        </span>
      </div>

      <div class="mb-3">
        <p class="text-14-regular text-text-weak">{props.request.prompt}</p>
        <Show when={props.request.command}>
          <p class="text-12-regular text-text-weaker mt-1">
            Command: <code class="text-text-weak">{props.request.command}</code>
          </p>
        </Show>
      </div>

      <div class="flex flex-col gap-3">
        <input
          type="password"
          class="w-full px-3 py-2 rounded-md border border-border-base bg-background-base text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
          placeholder={language.t("secureInput.placeholder", { fallback: "Enter password..." })}
          value={inputValue()}
          onInput={(e) => setInputValue(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          disabled={isSubmitting()}
          autofocus
        />

        <div class="flex gap-2 justify-end">
          <Button variant="secondary" size="small" onClick={handleCancel} disabled={isSubmitting()}>
            {language.t("common.cancel", { fallback: "Cancel" })}
          </Button>
          <Button variant="primary" size="small" onClick={handleSubmit} disabled={isSubmitting() || !inputValue()}>
            {language.t("common.submit", { fallback: "Submit" })}
          </Button>
        </div>
      </div>
    </div>
  )
}
