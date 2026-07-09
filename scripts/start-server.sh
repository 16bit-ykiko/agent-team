#!/bin/bash
# Start the Agent Team server.
# Builds a PATH from common install locations so systemd can find node.
export PATH="$HOME/.pixi/envs/nodejs/bin:$HOME/.pixi/envs/default/bin:$HOME/.pixi/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"

# Optional: configure proxy by setting http_proxy/https_proxy in your environment,
# or uncomment the lines below:
# export http_proxy=http://127.0.0.1:7890/
# export https_proxy=http://127.0.0.1:7890/

cd "$(dirname "$0")/.."
exec node dist/server.js
