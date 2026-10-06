#!/bin/bash
# Mints a Supabase session for the harness test account and hands the access
# token to the harness ONLY as the HARNESS_JWT environment variable. Nothing
# here prints the token, the anon key, or the password; the token is verified
# with one authenticated GET /auth/v1/user and the only output is "jwt ok" or
# the error.
#
# Usage:
#   ./mint-jwt.sh                        mint + verify, print "jwt ok", discard the token
#   ./mint-jwt.sh <command> [args...]    mint + verify, then exec the command with HARNESS_JWT set
#   . ./mint-jwt.sh                      (bash or zsh) mint + verify, export HARNESS_JWT in this shell
#
# Inputs, all overridable from the environment:
#   SUPABASE_URL, SUPABASE_ANON_KEY      default: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
#                                        read from HARNESS_ENV_FILE (default: the web studio's .env.local)
#   HARNESS_LOGIN_EMAIL, HARNESS_LOGIN_PASSWORD
#                                        default: parsed from the onboarding-test line of HARNESS_MEMORY_FILE
#                                        (default: ~/.claude/projects/-Users-michaelcolley/memory/MEMORY.md)
# Supabase sessions last one hour; mint again for a run that starts later than that.

# The HTTP part runs in node (fetch, JSON). Credentials reach it through its
# environment, never through argv. Written without single quotes so it can sit
# in a single-quoted shell string.
_MINT_JWT_JS='
(async () => {
    const url = String(process.env.MJ_URL || "").replace(/\/+$/, "");
    const anon = process.env.MJ_ANON || "";
    const email = process.env.MJ_EMAIL || "";
    const password = process.env.MJ_PASSWORD || "";
    const fail = (m) => { process.stderr.write(`jwt error: ${m}\n`); process.exit(1); };
    const brief = async (r) => {
        let t = "";
        try { const j = await r.json(); t = j.error_description || j.msg || j.message || j.error || j.error_code || ""; } catch (e) { t = ""; }
        return String(t).slice(0, 200);
    };
    let r;
    try {
        r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}` },
            body: JSON.stringify({ email, password }),
        });
    } catch (e) { fail(`sign-in request failed: ${e.message}`); }
    if (!r.ok) fail(`sign-in failed: HTTP ${r.status} ${await brief(r)}`.trim());
    const session = await r.json();
    const token = session.access_token;
    if (!token) fail("sign-in response carried no access_token");
    let u;
    try {
        u = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } });
    } catch (e) { fail(`verify request failed: ${e.message}`); }
    if (!u.ok) fail(`verify failed: GET /auth/v1/user HTTP ${u.status} ${await brief(u)}`.trim());
    const user = await u.json();
    if (!user || !user.id) fail("verify returned no user id");
    process.stderr.write(`jwt ok (expires in ${session.expires_in ?? "?"} s)\n`);
    process.stdout.write(token);
})().catch((e) => { process.stderr.write(`jwt error: ${e.message}\n`); process.exit(1); });
'

_mint_jwt() {
    local env_file="${HARNESS_ENV_FILE:-$HOME/Desktop/selahtranslate/app.selahtranslate.com/.env.local}"
    local memory_file="${HARNESS_MEMORY_FILE:-$HOME/.claude/projects/-Users-michaelcolley/memory/MEMORY.md}"
    local url="${SUPABASE_URL:-}"
    local anon="${SUPABASE_ANON_KEY:-}"
    local email="${HARNESS_LOGIN_EMAIL:-}"
    local password="${HARNESS_LOGIN_PASSWORD:-}"
    local line
    if [ -z "$url" ] || [ -z "$anon" ]; then
        if [ ! -r "$env_file" ]; then
            echo "jwt error: cannot read $env_file (set SUPABASE_URL and SUPABASE_ANON_KEY instead)" >&2
            return 1
        fi
        [ -n "$url" ] || url="$(sed -n 's/^NEXT_PUBLIC_SUPABASE_URL=//p' "$env_file" | tail -n 1 | tr -d '"'"'"'\r')"
        [ -n "$anon" ] || anon="$(sed -n 's/^NEXT_PUBLIC_SUPABASE_ANON_KEY=//p' "$env_file" | tail -n 1 | tr -d '"'"'"'\r')"
    fi
    if [ -z "$email" ] || [ -z "$password" ]; then
        if [ ! -r "$memory_file" ]; then
            echo "jwt error: cannot read $memory_file (set HARNESS_LOGIN_EMAIL and HARNESS_LOGIN_PASSWORD instead)" >&2
            return 1
        fi
        line="$(grep -m 1 'onboarding-test@selahtranslate.com' "$memory_file")"
        [ -n "$email" ] || email="$(printf '%s' "$line" | grep -o '[A-Za-z0-9._-]*@selahtranslate\.com' | head -n 1)"
        [ -n "$password" ] || password="$(printf '%s' "$line" | sed -n 's/.*(pw since [0-9-]*: *\([^;)]*\).*/\1/p' | sed 's/[[:space:]]*$//')"
    fi
    if [ -z "$url" ] || [ -z "$anon" ]; then
        echo "jwt error: Supabase URL or anon key not found" >&2
        return 1
    fi
    if [ -z "$email" ] || [ -z "$password" ]; then
        echo "jwt error: test account email or password not found" >&2
        return 1
    fi
    HARNESS_JWT="$(MJ_URL="$url" MJ_ANON="$anon" MJ_EMAIL="$email" MJ_PASSWORD="$password" node -e "$_MINT_JWT_JS")" || { unset HARNESS_JWT; return 1; }
    if [ -z "$HARNESS_JWT" ]; then
        echo "jwt error: empty token" >&2
        unset HARNESS_JWT
        return 1
    fi
    return 0
}

_mj_sourced=0
if [ -n "${ZSH_EVAL_CONTEXT:-}" ]; then
    case "$ZSH_EVAL_CONTEXT" in *:file|*:file:*) _mj_sourced=1 ;; esac
elif [ -n "${BASH_SOURCE:-}" ] && [ "${BASH_SOURCE[0]}" != "$0" ]; then
    _mj_sourced=1
fi

if [ "$_mj_sourced" = 1 ]; then
    if _mint_jwt; then export HARNESS_JWT; fi
    unset -f _mint_jwt
    unset _mj_sourced _MINT_JWT_JS
else
    _mint_jwt || exit 1
    export HARNESS_JWT
    if [ $# -gt 0 ]; then
        exec "$@"
    fi
fi
