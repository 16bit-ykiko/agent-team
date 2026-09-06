## 1 system done
  text "🤖 **A** joined the team"
## 2 user done
  text "Use the Skill tool to invoke the skill named hello, then reply with what it said."
## 3 agent done ctx 27265/1000000
  text "Hello from the skill."
  tool Skill "**Skill** ```json { \"skill\": \"hello\" } ```" → "Launching skill: hello"
