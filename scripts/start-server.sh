#!/bin/bash
export HOME=/home/ykiko
export PATH="$HOME/.pixi/envs/nodejs/bin:$HOME/.pixi/envs/default/bin:$HOME/.pixi/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/mnt/c/Windows/System32"
export http_proxy=http://127.0.0.1:7890/
export https_proxy=http://127.0.0.1:7890/
sudo -n /usr/bin/systemctl restart wsl-interop 2>/dev/null || true
cd /home/ykiko/workspace/agent-team
exec node dist/server.js
