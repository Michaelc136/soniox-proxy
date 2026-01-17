#!/bin/bash

# GitHub repository creation and push script
# Usage: ./create-and-push.sh YOUR_GITHUB_TOKEN

set -e

GITHUB_USER="Michaelc136"
REPO_NAME="soniox-proxy"
GITHUB_TOKEN="${1}"

if [ -z "$GITHUB_TOKEN" ]; then
    echo "❌ Error: GitHub personal access token required"
    echo ""
    echo "Usage: ./create-and-push.sh YOUR_GITHUB_TOKEN"
    echo ""
    echo "To create a token:"
    echo "1. Go to https://github.com/settings/tokens"
    echo "2. Click 'Generate new token (classic)'"
    echo "3. Select 'repo' scope"
    echo "4. Copy the token and run: ./create-and-push.sh YOUR_TOKEN"
    exit 1
fi

echo "🚀 Creating GitHub repository: $REPO_NAME..."

# Create repository via GitHub API
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/user/repos \
  -d "{
    \"name\": \"$REPO_NAME\",
    \"private\": true,
    \"description\": \"WebSocket proxy server for Soniox speech-to-text API\",
    \"auto_init\": false
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "201" ]; then
    echo "✅ Repository created successfully!"
elif [ "$HTTP_CODE" = "422" ]; then
    echo "⚠️  Repository might already exist, continuing..."
elif [ "$HTTP_CODE" = "401" ]; then
    echo "❌ Authentication failed. Please check your token."
    exit 1
else
    echo "❌ Failed to create repository. HTTP $HTTP_CODE"
    echo "$BODY"
    exit 1
fi

echo ""
echo "📤 Pushing code to GitHub..."

# Add remote and push
git remote remove origin 2>/dev/null || true
git remote add origin "git@github.com:$GITHUB_USER/$REPO_NAME.git"
git branch -M main
git push -u origin main

echo ""
echo "✅ Success! Repository: https://github.com/$GITHUB_USER/$REPO_NAME"
