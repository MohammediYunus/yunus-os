# Local security boundaries

## Intended use

Yunus OS serves one person's workspace through a loopback HTTP service. It is not a hosted service, a multi-user server, or a security boundary against another process running as that person. Do not expose the service through a public tunnel, reverse proxy or network interface.

The public repository is a fresh export of generic presentation and new configurable integrations. It does not need the original private application, operational data, account state or repository history.

## Static browser demo

The browser demo is a separate static export with fictional repositories, graph and activity. Its explicit build allowlist includes presentation code, bundled fonts, license notices and generated-data code. It excludes the local transport, connection forms, microphone capture, server modules, native wrapper, runtime profiles and tests.

Its task adapter makes no API or provider requests. It accepts only checklist changes and a read-aloud preference; live connections, credentials, binary uploads and desktop actions are rejected. The built-in summary and task commands do not invoke a model. Optional spoken replies use an installed local browser voice, if available, and start only after the user enables them and asks for a reply.

Task data is validated and saved under a versioned, project-path-scoped localStorage key. Storage belongs to the browser origin, so sibling sites on the same origin and installed browser extensions are not isolated from it. Do not put secrets into demo tasks. Clearing browser site data removes saved tasks; denied storage produces a visibly temporary page session. Other open tabs reload saved state before ordinary reads and edits, but localStorage is not a transactional database and simultaneous cross-tab writes can race.

The generated HTML sets a content security policy that blocks data connections. Static hosting does not inherit the local server's authentication or HTTP headers, and a CSP meta tag cannot enforce frame-ancestors. GitHub Pages serves the public assets under its own hosting and privacy policies; this is not a claim that the hosting provider collects no request data.

## HTTP boundary

The server listens on 127.0.0.1. It validates the request Host against the local origin and rejects foreign Origin headers. Browser cross-site requests must not obtain a session. It does not enable cross-origin resource sharing.

The session endpoint issues an unpredictable process-local token. Frontend JavaScript keeps that token in memory. All data endpoints and mutation endpoints require it through X-Yunus-Token. Credentials and session tokens are not accepted in URL query strings. The public health endpoint reveals only basic health/version information.

JSON mutations require application/json and have a 64 KiB body limit. Local voice transcription accepts a bounded WAV request, capped at 10 MiB, and reserves the active request slot while the upload is received. Invalid configurations are rejected before saving. A native or command-line client can omit Origin when it supplies a valid session token; an Origin header, when present, must match.

Static delivery uses explicit presentation assets. It does not publish the repository root, configuration directory, runtime files, source server modules or voice caches. Traversal and malformed-path checks supplement the asset allowlist. Browser protections include a content security policy, frame embedding restrictions and content-type sniffing prevention.

## Local data and credentials

The default profile directory is ~/.config/yunus-os. YOS_CONFIG_DIR selects another directory. On POSIX systems the directory is created with mode 0700 and configuration/task files with mode 0600. Windows access also depends on the chosen directory's ACLs and user account; POSIX mode assertions are not a claim of Windows ACL isolation.

GitHub tokens are saved only in local server configuration and omitted from API responses. A hasToken flag lets the UI show connection state. Tokens are not encrypted at rest. An empty token field preserves an existing token; explicit clearing removes it from the saved profile. Revocation at GitHub is separate.

Optional ElevenLabs keys follow the same local storage boundary. Only a hasElevenlabsApiKey flag is returned to the browser; a blank key preserves the saved value, and explicit clearing removes it. Keys are not read from shared ChatGPT connections, environment variables or other applications. Use a dedicated key restricted to text-to-speech and a provider-enforced credit quota. The profile is not encrypted at rest and does not isolate the key from another process with access to the same operating-system account. Clearing the saved key is separate from revoking it at ElevenLabs.

Local source scanning and Git queries only inspect the paths selected in configuration. The collector does not request repository writes. Select trusted repositories only: Git itself can honor local and user configuration, including configured clean filters. A read-only Git command is not a sandbox against malicious repository configuration. File/folder and supported import relationships are useful navigation aids, not a security audit or full semantic graph.

## Optional capabilities

The default demo uses synthetic data and does not need network, provider or subprocess access. First launch without a saved profile must not start providers, synthesize speech, record a microphone, discover accounts or run desktop actions. If a user explicitly configures an assistant model provider and sends it a request, that provider can run while the workspace is in demo mode too. ElevenLabs speech is restricted to live workspace mode as described below.

The built-in assistant is local. Optional Ollama or Claude CLI functionality uses the configured provider only on a requested interaction. Messages and included workspace context can leave the device when using an external provider. Existing subscriptions and API usage follow the provider's terms. Do not assume a third-party model is free or local.

Voice transcription uses a local Whisper executable and model chosen by the user. Spoken output uses available local operating-system capabilities by default. No cloud voice key or paid model download is required. Read-aloud does not require microphone setup.

ElevenLabs speech output is separately selected and requires voice to be enabled, live workspace mode, a saved key and a voice ID. Its authenticated POST endpoint sends only the supplied reply text and configured model ID to a fixed HTTPS ElevenLabs text-to-speech endpoint. It rejects redirects, bounds text to 4,000 characters and audio to 8 MiB, and uses a timeout. Settings and capability checks do not make provider requests. Provider errors are mapped to safe messages rather than exposing response bodies or credentials. It does not retry uncertain or rejected provider requests automatically. Local session recovery may retry only the explicit pre-handler rejection, which cannot have generated speech.

Speech has a separate cancellation lifecycle from assistant text and local transcription. Stop, connection changes and server shutdown cancel pending speech requests. The client also stops playback and discards stale speech when the drawer closes or a new request starts. Browser autoplay recovery reuses the existing audio blob. Cancellation does not promise a refund or prevent billing for work the provider has already started. Cloud speech is unavailable in both the local demo workspace and the static browser demo, even if cloud speech settings were previously saved.

The built-in assistant recognizes a narrow, explicit task command: Add a task: followed by a title of up to 240 characters. It returns a proposal and saves nothing until the user approves that action. Task approvals write only the local checklist. External provider replies are text only and cannot return executable actions.

App opening also requires an explicit approved action. General screen capture, mouse/keyboard operation and autonomous desktop task execution are not part of this release. The app has no email integration, mailbox edits or mailbox drafts.

## Verification

The security suite launches the real server in a temporary profile with an empty home directory. A process-local test guard rejects and records attempted network connections and child processes while checking demo behavior. Other tests cover hostile Host/Origin/fetch metadata, missing or incorrect tokens, simple form content types, source-file/traversal denials, request limits, credential redaction and POSIX file modes.

These tests do not certify the operating system, provider executables, browser extensions or dependency-free code as safe. Review new endpoints and capabilities against these boundaries. Tests using real accounts, paid providers or desktop actions must be separately scoped and must not run in public CI.

Before publishing a release, scan the final export for secrets with redacted output, inspect its file list, retain font notices and review the demo media for private information. A secret scanner does not replace a review of data, screenshots or permission boundaries.
