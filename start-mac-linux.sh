#!/usr/bin/env bash
set -e
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi
echo "Starting Human Nature Stories Studio..."
npm start
