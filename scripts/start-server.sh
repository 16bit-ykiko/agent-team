#!/bin/bash
export HOME=/home/ykiko
export PATH="$HOME/.pixi/envs/nodejs/bin:$HOME/.pixi/envs/default/bin:$HOME/.pixi/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
cd /home/ykiko/discord-agent-team
exec .pixi/envs/default/bin/node dist/server.js
