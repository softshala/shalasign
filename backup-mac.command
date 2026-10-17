#!/bin/bash
# Makes a dated backup zip of ALL your SignFlow data (accounts, documents,
# signed PDFs, audit history) onto your Desktop. Run it whenever you like.
DATA="$HOME/SignFlowData"
STAMP=$(date +%Y-%m-%d_%H%M)
DEST="$HOME/Desktop/SignFlow-backup-$STAMP.zip"

if [ ! -d "$DATA" ]; then
  echo "No data folder found yet at $DATA — run the app at least once first."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

cd "$HOME" && zip -rq "$DEST" "SignFlowData"
echo "Backup saved to: $DEST"
echo "Keep a copy somewhere safe (another drive, Google Drive, etc.)."
read -n 1 -s -r -p "Press any key to close..."
