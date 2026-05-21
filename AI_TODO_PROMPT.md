# AI Prompt For Rollbridge TODO Work

Use this prompt when asking an AI agent to implement one or more isolated Rollbridge TODO items.

```text
You are working in the Rollbridge repository.

Goal:
Pick one or more isolated unchecked items from TODO.md and implement them end to end. Prefer one focused item unless several TODOs are tightly coupled and can be completed cleanly in the same change.

Before changing files:
1. Read README.md, TODO.md, package.json, and the source files related to the chosen TODO item.
2. State the exact TODO item(s) you are taking.
3. Confirm the item is isolated. Do not combine unrelated roadmap items.

Scope rules:
- Keep the diff focused on the selected TODO item(s).
- Do not add Capistrano plugins, Capistrano tasks, or Capistrano-specific integration code. Deploy tools should call Rollbridge through CLI commands.
- Capistrano documentation examples are allowed only as shell-command recipes that invoke Rollbridge CLI commands.
- Do not change runtime behavior for documentation-only TODOs.
- Do not mark a TODO checkbox complete unless the feature or document is actually finished and validated.
- If the work changes public config, CLI output, command names, or operational behavior, update README.md or dedicated docs in the same change.

Implementation expectations:
- Follow existing Rollbridge patterns and JSDoc style.
- Keep config validation at the boundary and trust normalized config downstream.
- Add behavior-focused tests for new process, daemon, CLI, config, or proxy behavior.
- For worker or memory supervision work, include status output and tests covering failure/restart behavior.
- For docs work, include concrete commands and examples that an operator can use.

Suggested acceptance criteria:
- The selected TODO item(s) are implemented or documented fully.
- Relevant TODO.md checkbox(es) are updated.
- npm run all-checks passes.
- The final response summarizes changed behavior, docs, tests, and any remaining follow-up work.

If the TODO item is too large:
Split it into a smaller independently shippable subtask, document the boundary in TODO.md, and implement only that subtask.
```
