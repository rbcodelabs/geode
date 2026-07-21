#!/bin/sh
# PostToolUse:Bash hook — reminds to run the pr-checklist skill after a git push.
# Reads the tool-call JSON payload from stdin, checks if the command was a
# git push, and if so emits hookSpecificOutput additionalContext JSON.
# Kept as a standalone script (rather than an inline jq filter in
# settings.json) to avoid nested-quote breakage across different hook
# invocation environments.

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"

case "$cmd" in
  *"git push"*)
    jq -n '{
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "QUALITY GATE: You just pushed to git. Before declaring this work done you MUST run the pr-checklist skill (or check .claude/pr-guidelines.md for this repo'"'"'s requirements). Do not tell the user the work is done until the full checklist passes."
      }
    }'
    ;;
esac

exit 0
