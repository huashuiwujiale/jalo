#!/bin/zsh
set -e
launch_root="${0:A:h}"
cd "$launch_root"
if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=14)?0:1)' 2>/dev/null; then
  for launch_node in "$HOME"/.nvm/versions/node/v22.*/bin/node(NOn) /opt/homebrew/bin/node; do
    if [[ -x "$launch_node" ]] && "$launch_node" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=14)?0:1)'; then
      export PATH="${launch_node:h}:$PATH"
      break
    fi
  done
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(!(major>22||(major===22&&minor>=14))){console.error("请安装 Node.js 22.14 或更新版本");process.exit(1)}'
if [[ ! -d node_modules ]]; then
  npm ci
fi
exec npm run dev
