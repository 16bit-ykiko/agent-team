## 1 system done
  text "🤖 **A** joined the team"
## 2 user done
  text "Start the shell command `sleep 12 && echo bg-finished` as a background task; do not wait for it. Reply with the single word started and end your turn. Later, when you are told that background command …"
## 3 agent done
  text "started"
  tool Bash "**Bash** ```bash sleep 12 && echo bg-finished ```" → "bg-finished" 19006ms
  card shell/local_bash completed 19006ms "```bash sleep 12 && echo bg-finished ```"
    summary "bg-finished"
## 4 user done
  text "Reply with the single word here."
## 5 agent done
  text "here"
  notice:wakeup "`sleep 12 && echo bg-finished` finished"
  tool Bash "**Bash** ```bash sleep 20 && echo after-wake ```" → "after-wake" 17425ms
  card shell/local_bash completed 17425ms "```bash sleep 20 && echo after-wake ```"
    summary "after-wake"
## 6 agent done
  text "woken"
  notice:wakeup "`sleep 20 && echo after-wake` finished"
