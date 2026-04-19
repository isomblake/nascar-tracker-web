#!/bin/bash
# One-shot: push the frontend to a new GitHub repo, ready for Vercel import.
# Run this from inside the frontend/ folder in Git Bash.
#
# Prerequisites:
#   1. Create an EMPTY repo on github.com called 'nascar-tracker-web'
#      (no README, no .gitignore, no license - totally empty)
#   2. Replace YOUR_GITHUB_USERNAME below if your username isn't 'isomblake'

set -e

GITHUB_USER="isomblake"
REPO_NAME="nascar-tracker-web"

echo "==> Installing dependencies..."
npm install

echo "==> Running build to confirm everything compiles..."
CI=true npm run build

echo "==> Initializing git..."
git init
git add .
git commit -m "Initial commit: nascar race tracker PWA"
git branch -M main

echo "==> Adding remote and pushing..."
git remote add origin "https://github.com/${GITHUB_USER}/${REPO_NAME}.git"
git push -u origin main

echo ""
echo "================================================================"
echo "DONE: pushed to https://github.com/${GITHUB_USER}/${REPO_NAME}"
echo "================================================================"
echo ""
echo "Next: tell Claude to continue — Claude will import this repo"
echo "in the Vercel tab and set up the environment variables for you."
