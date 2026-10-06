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

## Soniox relay environment variables (reliability, 2026-10)

All optional. Defaults apply when a variable is unset. Flags accept `on`/`off`,
`true`/`false`, `1`/`0`. Details and rationale: `docs/reliability-2026-10.md`.
Run the suite with `npm test` (uses the mock in `test/mock-soniox.js`).

| Variable | Default | What it does |
|---|---|---|
| `SONIOX_WS_URL` | `wss://stt-rt.soniox.com/transcribe-websocket` | Upstream endpoint. Tests point it at the mock. |
| `SONIOX_LANG_ID` | `on` | Sends `enable_language_identification: true` so tokens carry `language`. |
| `SONIOX_STRICT_HINTS` | `on` | Sends `language_hints_strict: true` when the client sent exactly one hint. |
| `SONIOX_KEEPALIVE_MS` | `10000` | After this long without audio, send `{"type":"keepalive"}` at this interval until audio resumes. |
| `SONIOX_STALL_WATCHDOG` | `on` | Detect "finals but no translation" and recycle the stream (translation sessions only). |
| `SONIOX_STALL_SEGMENTS` | `6` | Consecutive untranslated segments before a stall is declared. |
| `SONIOX_STALL_QUIET_MS` | `20000` | Minimum time since the last translation token before a stall is declared. |
| `SONIOX_STALL_COUNT_NONE` | `on` | Count finals tagged `translation_status: none` (speech Soniox judged outside the pair, so no translation follows) as untranslated segments. |
| `SONIOX_SEGMENT_GAP_MS` | `700` | Without an `<end>` token, a run of finals followed by this much silence closes a segment. |
| `SONIOX_RECYCLE_MIN_INTERVAL_MS` | `120000` | At most one stall recycle per client in this window. |
| `SONIOX_RECYCLE_MAX` | `3` | Stall recycles allowed per `SONIOX_RECYCLE_WINDOW_MS`; past it, `translation_unavailable` is sent once. |
| `SONIOX_RECYCLE_WINDOW_MS` | `600000` | Window for `SONIOX_RECYCLE_MAX`. |
| `SONIOX_ROTATION` | `on` | Roll to a fresh upstream before the fixed 300 minute cap. |
| `SONIOX_ROTATE_SOFT_MIN` | `270` | Minutes (max of audio and wall) at which the replacement is pre-dialed and the switch waits for the next endpoint. |
| `SONIOX_ROTATE_HARD_MIN` | `290` | Minutes at which the switch happens immediately. |
| `SONIOX_ROTATE_BACKSTOP_MIN` | `292` | Wall-clock timer that forces the switch. |
| `SONIOX_ROTATE_QUIET_MS` | `600` | After the soft mark, switch after this long with no tokens if no endpoint arrives. Endpoint and quiet switches wait for the replacement's ack; only the hard mark and backstop switch unacked. |
| `SONIOX_ROTATE_RETRY_MS` | `5000` | First retry delay when a soft-mark pre-dial is refused; doubles each failure (the old stream is kept meanwhile). |
| `SONIOX_ROTATE_RETRY_MAX_MS` | `60000` | Cap on that backoff. The hard mark ignores the backoff. |
| `SONIOX_MIN_DIAL_INTERVAL_MS` | `1000` | A repeated `action:start` with a new config re-dials at most this often (latest config wins); identical repeats are suppressed. |
| `SONIOX_FINALIZE_TAIL_MS` | `1500` | How long the old stream's final tail is forwarded after `finalize` (ends early on `<fin>`). |
| `SONIOX_END_GRACE_MS` | `500` | Wait for `finished` after the empty end frame before closing the old stream. |
| `SONIOX_AUDIO_BUFFER_MS` | `15000` | Audio buffered while no upstream can take it (switch or re-dial); oldest frames drop past the cap. |
| `SONIOX_REDIAL_DELAYS_MS` | `1000,3000` | Re-dial attempts after an upstream loss. A missed rotation (`max_duration_reached`) dials immediately first. |
| `SONIOX_ACK_TIMEOUT_MS` | `10000` | Connect plus start ack deadline per dial. |
| `SONIOX_OVERLAP_WARN_MS` | `3000` | Log when two upstreams overlap longer than this during a switch. |
| `SONIOX_SUMMARY_MS` | `60000` | Per-stream counter summary log interval. |
| `SONIOX_HEARTBEAT_MS` | `20000` | WebSocket ping interval on both legs. |
| `SONIOX_ROTATION_TICK_MS` | `1000` | How often rotation marks are checked when no audio is flowing. |

Client-facing additions (both clients ignore unknown frame types):
`{"type":"proxy_notice","event":"translation_stalled"}`, `stream_recycled`,
`stream_rotated` (with `minutes`), `translation_unavailable`. `proxy_ready` is
sent exactly once per client connection. On an unrecoverable upstream failure
the proxy sends `{"type":"error","code":..,"message":..}` and closes the client
socket with 1011 so the client's own reconnect runs. A pre-dialed rotation
replacement receives `{"type":"keepalive"}` on the keepalive interval while it
waits for the switch, so Soniox's 20 s idle rule cannot close it.

### Rollback

If a rotation or a stall recycle misbehaves during a live session, in order of
speed:

1. **Fastest, no code change.** In the App Platform console set
   `SONIOX_ROTATION=off` and `SONIOX_STALL_WATCHDOG=off` on the `selah-proxy`
   component and redeploy. That leaves keepalive, key redaction, strict hints
   and language identification in place (all safe), and removes every
   automatic stream switch. Confirm in the startup log:
   `Soniox relay: ... stallWatchdog=false ... rotation=false ...`.
2. **Full.** Redeploy the last pre-relay build, commit `a171dfd`
   ("DeepL: auto-detect Free vs Pro endpoint by key suffix"). In the App
   Platform console open **Deployments**, pick the deployment built from
   `a171dfd`, and choose **Redeploy**; or push a revert of the relay commits to
   `main` and let the autodeploy run. Confirm the startup log no longer prints
   a `Soniox relay:` line. The 300 minute cap and the stall symptom return
   with it, so treat this as the emergency path only.

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
