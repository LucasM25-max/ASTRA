#!/bin/bash
set -euo pipefail
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}/tmp/stubs"
PY="${BPY_PYTHON:-/tmp/bpyenv/bin/python}"
"$PY" "$(dirname "$0")/build_assets.py"
