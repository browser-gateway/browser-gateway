/** UI copy strings shared between OSS and SaaS provider forms. Keeping them
 *  here means changes to wording land in both dashboards in one edit. */

export const PROVIDER_FORM_COPY = {
  name: {
    label: "Provider name",
    placeholder: "my-playwright, cloud-provider, office-chrome",
    hint: "Unique name to identify this provider. Lowercase, numbers, hyphens.",
  },
  url: {
    label: "Provider URL",
    placeholder: "wss://provider.com?token=xxx or http://localhost:9222",
    hint: "wss:// for cloud services, ws:// for local WebSocket servers, or http:// for Chrome remote debugging. Include the API token in the URL if the provider requires one.",
  },
  profile: {
    label: "Which profiles it serves",
    anyOption: "Any profile",
    noneOption: "Sessions with no profile",
    hintAny: "Loads any profile a client asks for. Best for providers that start a fresh browser each session.",
    hintPinned: (slug: string) => `Only sessions that connect with ?profile=${slug} are sent here.`,
    hintNone: "Only sessions with no ?profile= are sent here.",
  },
  maxConcurrent: {
    label: "Max connections",
    placeholder: "No limit",
    hint: "Max simultaneous sessions. Empty for no limit.",
  },
  priority: {
    label: "Priority",
    placeholder: "100",
    hintStatic: "Lower wins. 1 for primary, 100 for fallback.",
  },
  weight: {
    label: "Weight",
    placeholder: "100",
    hintStatic: "Higher receives more traffic when providers share a priority.",
  },
  advanced: {
    label: "Advanced",
    headersLabel: "Custom headers",
    headersHint: "Sent on the WebSocket upgrade to the provider. Use for providers that require Bearer tokens or custom auth.",
    addHeader: "Add header",
    headerNamePlaceholder: "Authorization",
    headerValuePlaceholder: "Bearer sk_live_...",
  },
  actions: {
    test: "Test",
    testing: "Testing",
    cancel: "Cancel",
    addProvider: "Add provider",
    saveChanges: "Save changes",
    saving: "Saving",
    adding: "Adding",
  },
  testResult: {
    ok: (latencyMs: number) => `Connected in ${latencyMs} ms`,
    fail: (reason: string) => `Could not connect: ${reason}`,
    unknownReason: "unknown",
  },
} as const;
