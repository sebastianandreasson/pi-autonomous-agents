# Project Setup

Suggested consuming-repo layout:

```text
TODOS.md
pi.config.json
pi/
  DEVELOPER.md
  TESTER.md
  tests/
  scripts/
```

Minimal install pattern:

1. Copy `templates/pi.config.example.json` to your repo as `pi.config.json`
2. Copy `templates/DEVELOPER.md` to `pi/DEVELOPER.md` and customize it
3. Copy `templates/TESTER.md` to `pi/TESTER.md` and customize it
4. Update `pi.config.json` so it points at those role files and your project-specific commands
5. Add the `gitignore.fragment` entries to your repo `.gitignore`
6. Create a fast verification command for `testCommand`
7. Optionally create a screenshot capture flow for `visualCaptureCommand`
8. Run:

```bash
PI_CONFIG_FILE=pi.config.json pi-harness once
```

Suggested package scripts in the consuming repo:

```json
{
  "scripts": {
    "pi:mock": "PI_CONFIG_FILE=pi.config.json PI_TRANSPORT=mock PI_TEST_CMD= pi-harness once",
    "pi:once": "PI_CONFIG_FILE=pi.config.json pi-harness once",
    "pi:run": "PI_CONFIG_FILE=pi.config.json pi-harness run",
    "pi:report": "PI_CONFIG_FILE=pi.config.json pi-harness report",
    "pi:visual:once": "PI_CONFIG_FILE=pi.config.json pi-harness visual-once"
  }
}
```
