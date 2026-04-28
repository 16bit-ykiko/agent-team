#!/bin/bash
export HOME=/home/ykiko
export PATH="$HOME/.pixi/envs/nodejs/bin:$HOME/.pixi/envs/default/bin:$HOME/.pixi/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/mnt/c/Windows/System32"
sudo -n /usr/bin/systemctl restart wsl-interop 2>/dev/null || true
cd /home/ykiko/discord-agent-team
exec .pixi/envs/default/bin/node dist/server.js
