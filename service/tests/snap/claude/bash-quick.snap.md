## 1 system done
  text "🤖 **A** joined the team"
## 2 user done
  text "Run `echo hi` with the Bash tool, then reply with the single word done."
## 3 agent done ctx 27211/1000000
  text "done"
  tool Bash "**Bash** ```bash echo hi ```" → "hi"
