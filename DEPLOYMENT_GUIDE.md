# Soniox Proxy Deployment Guide

## ✅ What's Done

1. ✅ Proxy server code created and pushed to GitHub: `https://github.com/Michaelc136/soniox-proxy`
2. ✅ iOS app updated to use DigitalOcean instead of AWS
3. ✅ App spec file created: `.do/app.yaml`

## 📋 Next Steps

### Step 1: Deploy to DigitalOcean App Platform

1. **Go to DigitalOcean Dashboard**: https://cloud.digitalocean.com/apps

2. **Click "Create App"**

3. **Connect GitHub** (if not already connected):
   - Click "GitHub" → Authorize DigitalOcean
   - Select your GitHub account

4. **Select Repository**:
   - Choose `Michaelc136/soniox-proxy`
   - Branch: `main`
   - DigitalOcean will auto-detect the Dockerfile

5. **Configure Environment Variables**:
   - Click "Edit" next to Environment Variables
   - Add these variables:
     ```
     PORT = 8080
     SONIOX_API_KEY = (your Soniox API key)
     SUPABASE_URL = https://vhnkwkvonudubyteespy.supabase.co
     SUPABASE_ANON_KEY = (your Supabase anon key)
     ```
   - Mark `SONIOX_API_KEY` and `SUPABASE_ANON_KEY` as **Encrypted/Secret**

6. **Configure App Settings**:
   - **Instance Size**: Basic (512MB RAM) - $5/month
   - **Instance Count**: 1
   - **Health Check**: `/health` (auto-configured)

7. **Deploy**:
   - Click "Create Resources"
   - Wait for deployment (2-5 minutes)

### Step 2: Get Your WebSocket URL

After deployment:

1. Go to your app in DigitalOcean Dashboard
2. Click **Settings** → **Domains**
3. You'll see a URL like: `soniox-proxy-xxxxx.ondigitalocean.app`
4. **Copy this URL** - you'll need it for the iOS app

### Step 3: Update iOS App with WebSocket URL

1. Open `Selah/Selah/UnifiedSonioxService.swift`
2. Find line ~1313:
   ```swift
   private let digitalOceanWebSocketEndpoint = "wss://YOUR_APP_URL.ondigitalocean.app"
   ```
3. Replace `YOUR_APP_URL.ondigitalocean.app` with your actual DigitalOcean app URL
4. **Important**: Make sure it starts with `wss://` (WebSocket Secure)

Example:
```swift
private let digitalOceanWebSocketEndpoint = "wss://soniox-proxy-abc123.ondigitalocean.app"
```

### Step 4: Test the Connection

1. Build and run the iOS app
2. Start translation
3. Check logs for:
   - `✅ proxy_ready received from DigitalOcean!`
   - `✅ DigitalOcean proxy connected to Soniox - ready for audio!`

## 🗑️ Clean Up AWS Resources

After confirming DigitalOcean works, delete these AWS resources:

### 1. API Gateway WebSocket API
- **AWS Console** → **API Gateway** → **APIs**
- Select `selah-translate-api` (or the API with ID `xf44sp0527`)
- **Actions** → **Delete**

### 2. Lambda Functions
- **AWS Console** → **Lambda** → **Functions**
- Delete:
  - `selah-connect`
  - `selah-disconnect`
  - `selah-default`

### 3. Lambda Layer
- **AWS Console** → **Lambda** → **Layers**
- Delete: `selah-dependencies`

### 4. Secrets Manager Secret
- **AWS Console** → **Secrets Manager**
- Delete: `selah-translate/api-keys`

### 5. IAM Role
- **AWS Console** → **IAM** → **Roles**
- Delete the role created for Lambda (likely `selah-lambda-role` or similar)

## 📊 Cost Comparison

- **AWS API Gateway**: ~$1-5/month (pay per connection hour)
- **DigitalOcean App Platform**: $5/month (Basic plan, 512MB RAM)
- **Winner**: DigitalOcean is simpler and more predictable for persistent connections

## 🔧 Troubleshooting

### Connection Timeout
- Check that environment variables are set correctly in DigitalOcean
- Verify the WebSocket URL in iOS app starts with `wss://`
- Check DigitalOcean app logs: **Runtime Logs** tab

### Authentication Errors
- Verify `SUPABASE_ANON_KEY` is correct
- Check that the JWT token is being passed in the WebSocket URL query string

### Soniox Connection Errors
- Verify `SONIOX_API_KEY` is correct and has proper permissions
- Check DigitalOcean app logs for Soniox connection errors

## 📝 Notes

- The proxy server maintains **persistent WebSocket connections** (unlike AWS Lambda)
- DigitalOcean App Platform automatically handles:
  - HTTPS/WSS termination
  - Health checks
  - Auto-scaling (if configured)
  - Logging

## 🎉 Success!

Once everything is working, you'll have:
- ✅ Persistent WebSocket proxy (no cold starts)
- ✅ Secure API key storage (never sent to client)
- ✅ Supabase JWT authentication
- ✅ Simple, predictable pricing
