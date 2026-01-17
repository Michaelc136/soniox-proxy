# Soniox WebSocket Proxy Server

A persistent WebSocket proxy server that securely connects iOS clients to the Soniox speech-to-text API.

## Features

- **JWT Authentication**: Verifies Supabase JWT tokens before allowing connections
- **Real-time Proxying**: Maintains persistent WebSocket connections between clients and Soniox
- **Health Check**: Built-in health check endpoint for monitoring
- **Graceful Shutdown**: Properly closes all connections on shutdown

## Environment Variables

Required environment variables:

- `SONIOX_API_KEY` - Your Soniox API key
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Your Supabase anonymous key
- `PORT` - Server port (defaults to 8080)

## Deployment

This server is designed to run on DigitalOcean App Platform or any Node.js hosting service.

## Health Check

The server exposes a health check endpoint at `/health`:

```bash
curl http://localhost:8080/health
```

## License

Private - Internal use only
