#!/usr/bin/env bash
set -euo pipefail
npm install --prefix server
npm --prefix server start
