#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
STAGE_DIR=$("$ROOT_DIR/scripts/stage-plugin.sh")
STAGE_PARENT=$(dirname "$STAGE_DIR")
STAGE_NAME=$(basename "$STAGE_DIR")

cd "$STAGE_PARENT"
rm -f "$STAGE_NAME"-*.iinaplgz
/Applications/IINA.app/Contents/MacOS/iina-plugin pack "$STAGE_NAME"
