#!/bin/bash

# SeniorStudio Deployment Script

echo "=== SeniorStudio Deployment ==="

# Check if Vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "Installing Vercel CLI..."
    pnpm add -g vercel
fi

# Check if logged in
echo "Checking Vercel login status..."
vercel whoami &> /dev/null
if [ $? -ne 0 ]; then
    echo "Please login to Vercel first:"
    vercel login
fi

# Deploy to Vercel
echo "Deploying to Vercel..."
vercel --prod

echo "=== Deployment Complete ==="
