# Contributing to Qahwa Tasks

[← Back to the project](../README.md)

## Issues and proposals

For a bug report, include what you expected, what happened, your browser and host environment, and steps to reproduce. Use synthetic data; remove project paths, conversations, pairing links, and credentials from shared evidence.

For a feature proposal, describe the workflow it improves and how it should behave on both a phone and desktop.

## Local development

Follow the [setup guide](../README.md#installation), then run:

```bash
npm run typecheck
npm test
npm run build
```

Report the checks you ran and any failures. For UI changes, include before/after screenshots with synthetic data and check narrow screens, light/dark themes, focus, and preservation of drafts and attachments. Shared workspace changes should cover both task and orchestrator views.

Use isolated data directories for verification. Keep production sessions, databases, and configured external tools out of automated tests.

## Pull requests

1. Keep the change focused and explain the problem it addresses.
2. Add or update tests when behavior changes, and update documentation when setup or usage changes.
3. Run the checks above and include their results, including existing failures.
4. Include screenshots for interface changes, using synthetic data.

The [README](../README.md#development) contains the source layout and the last recorded validation failures. There is no passing CI claim for this revision.

This project is licensed under the [MIT License](../LICENSE).
