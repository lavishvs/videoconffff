#!/usr/bin/env bash
set -e

# Change to repo directory (script location)
cd "$(dirname "$0")"

# Activate virtual environment
if [ -f "venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source venv/bin/activate
else
  echo "Virtualenv not found. Please create it first: python3 -m venv venv && source venv/bin/activate"
  exit 1
fi

# Environment variables. Values from .env or the shell take priority.
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

export FLASK_KEY="${FLASK_KEY:-5f2d4e8c1b9a7f3e0d2c6b8a4f1e3d5c7b9a2f4e6d8c0b1a}"
export AGORA_API="${AGORA_API:-71f2e7309f054eeda62c1ab941669fab}"
export AGORA_APP_CERTIFICATE="${AGORA_APP_CERTIFICATE:-}"
export GEMINI_API_KEY="${GEMINI_API_KEY:-}"
export GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-620903352671-v1j77g4d8ineqqcqqtbujuk91r6fvgb2.apps.googleusercontent.com}"
export GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-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}"

if [ -z "$AGORA_APP_CERTIFICATE" ]; then
  echo "Warning: AGORA_APP_CERTIFICATE is not set. Video only works if your Agora project has App Certificate disabled."
fi

# Start the app (foreground). Use Ctrl+C to stop.
exec python main.py
