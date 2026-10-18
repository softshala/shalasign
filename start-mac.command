#!/bin/bash
cd "$(dirname "$0")"
echo "============================================"
echo " ShalaSign — starting up (first run takes a"
echo " few minutes while it downloads components)"
echo "============================================"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js is not installed yet."
  echo "Please install it first from https://nodejs.org (click the green LTS button),"
  echo "then double-click this file again."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo ""
  echo "ShalaSign needs Node.js 22 or newer; you have $(node --version)."
  echo "Please install the current LTS from https://nodejs.org and run this file again."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

echo "Checking app components (quick if already installed)..."
(cd server && npm install --silent --no-audit --no-fund)
(cd client && npm install --silent --no-audit --no-fund)
[ -d client/dist ] || (echo "Preparing the app screens..." && cd client && npm run build --silent)

echo ""
echo "ShalaSign is running! Opening it in your browser..."
echo "Keep this window open while you use the app."
(sleep 2 && open http://localhost:4000) &
cd server && NODE_NO_WARNINGS=1 node src/index.js
