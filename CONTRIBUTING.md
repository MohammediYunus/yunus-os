# Contributing

Thanks for helping make Yunus OS useful on more people's computers.

Use Node.js 22 or newer. There are no runtime npm dependencies to install:

```sh
npm start
npm test
```

## Before changing behavior

Read the [README](README.md) and [security boundaries](docs/security.md). Keep demo mode useful without accounts, network access, provider processes or private data. For larger features, discuss the intended user experience in an issue first. A small bug fix can go straight to a pull request.

Keep changes focused. Include a regression test that fails before a behavior fix, explain the observed problem, and report the checks you actually ran. Screenshots or short videos help with visible changes; use synthetic data and keep desktop notifications and account details out of them.

## Connector requirements

- Connections must be explicit. Do not discover credentials from another application, import a developer's home configuration, or switch a global CLI account.
- Demo data must stay visibly distinguishable from live data. Connection failures must be reported honestly.
- Use argument arrays for child processes, validate configuration and outbound destinations, and keep credentials out of browser responses and logs.
- Tests must use fixture responses and temporary folders. They must not require maintainers' accounts, paid services or changes to real repositories.
- Do not add email/mailbox actions or unrestricted desktop automation. Proposed capability expansions need a separate design and security review.

## Submitting a pull request

Describe what changes for a user, why it is needed, and how you verified it. Review every change before submitting it. Do not claim tests, security properties or platform support that you have not checked.

By contributing, you agree that your contribution can be distributed under the repository's MIT license. Keep existing third-party notices, including the font OFL files. Never include code or data you are not entitled to share.
