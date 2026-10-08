# Security policy

Yunus OS is a local application. Only the latest public release is currently supported for security fixes. It is not designed to host multiple users or to be exposed to the internet.

## Report a vulnerability

Use the repository's private vulnerability reporting feature under **Security → Report a vulnerability**, when enabled. Please include the affected version, operating system, a minimal reproduction using synthetic data, and the observed impact. Do not include real tokens, account exports, private repositories or recordings of unrelated applications.

If private reporting is unavailable, open a public issue containing only a request for a private reporting channel. Do not publish exploit details or credentials in that issue. No response-time guarantee is currently offered.

## Boundaries

- The HTTP service binds to loopback. Host, Origin and session-token checks protect the local API from other websites; they do not protect against malicious software already running as your user.
- Configuration stays outside the checkout. Tokens are server-side and excluded from API responses. They are not encrypted at rest.
- Repository and GitHub connectors are read-only. Local task edits affect only Yunus OS's profile data.
- The release has no mailbox integration or email draft creation, and no unrestricted autonomous GUI operator.
- Optional assistant providers can process the text/context sent to them. Selecting a provider does not make that provider local or free.
- Protect your operating-system account, browser extensions and disk. Do not share a live connected dashboard publicly.

See [docs/security.md](docs/security.md) for the implementation and test boundaries. A passing test suite or secret scan is not a guarantee that all vulnerabilities have been found.
