# CHASE.EXE — Backend + ESP32 setup

This package contains the single-file HTML game frontend and a small Node.js WebSocket backend. The backend supports random-player matchmaking plus private 8-character invite rooms. It assigns per-player session tokens, validates inputs, simulates movement on the server, decides whether the runner escaped or was tagged, expires waiting invite panels after 120 seconds, and can remember player profiles and match records in PostgreSQL. The visual map is a camera-follow woodland research site. The mobile frontend now uses a full-viewport landscape play layout, thumb-zone joystick on the lower-left and sprint button on the lower-right, a rotate-phone screen for portrait gameplay on touch devices, adaptive canvas sizing, and a native high-contrast consent checkbox in the player profile popup. Tap **TRY LANDSCAPE MODE** or rotate the phone manually; orientation locking depends on browser and device support.

## Credentials and authentication

- The browser HTML contains **no Firebase API key, Firebase password, service-account file, or shared admin key**.
- This version does not use Firebase at all, so there is no Firebase API key to move into `.env`.
- The backend creates random room codes and session tokens. It validates the token when a browser reconnects. The token is specific to that room/player session; it is not an administrator credential.
- Active rooms remain in server memory; active matches are cleared on server restart/redeploy.
- When `DATABASE_URL` points to PostgreSQL, the backend remembers a random browser player ID, callsign, first/last-seen timestamps, the latest IP address, match count, wins, and losses. Profile-token hashes are stored instead of the raw profile token.
- The latest IP is visible only in the backend database, never sent to other players. The game asks players to explicitly accept this notice before connecting. IP addresses are automatically cleared after 30 days without a multiplayer connection by default; profile/stat records remain until the player uses **FORGET SAVED PROFILE** or asks the site owner to remove them.
- A browser's random player ID is stored in localStorage and is more reliable for remembering someone than using an IP address alone (many people share an IP, and IPs can change).

## Configure persistent player memory (PostgreSQL)

The database is optional for local game testing, but required if you want player profiles, last IP, and match statistics to survive backend restarts.

**Recommended for a long-running hobby project:** use a Neon PostgreSQL database and copy its connection string from the Connect panel (use the pooled connection string if available). It should include `sslmode=require`; keep this URL private. Neon currently offers a free plan with usage limits: <https://neon.com/pricing>.

You can also use Render Postgres. In that case, copy the **Internal Database URL** if the database and web service are in the same Render region. Important: Render's Free Postgres databases currently expire 30 days after creation, so do not use that plan for indefinite profile retention unless you upgrade or migrate: <https://render.com/docs/free>.

Then configure either provider:

1. Open the `chasebackend-9loz` web service in Render and go to **Environment**.
2. Add the secret environment variable `DATABASE_URL` and paste the database connection URL. Never put this URL in the game HTML or GitHub.
3. Save and deploy the web service. The backend creates `chase_players` and `chase_matches` automatically at startup.
4. Open `https://chasebackend-9loz.onrender.com/health`. Confirm the response contains `"storage":{"enabled":true,"type":"postgres"}`. If `enabled` is false, check `DATABASE_URL` and the latest deployment logs.

Waiting invitation/random-match panels expire after 120 seconds by default. `ROOM_WAIT_TIMEOUT_MS` changes the timeout; `PROFILE_IP_RETENTION_DAYS` changes the IP retention period (default 30 days).

### Player data collected

After consent, the backend stores the browser-generated random player ID, callsign, last IP address, first/last seen timestamps, and aggregate match results. It does not expose IP addresses to opponents. The game UI describes this before matchmaking and includes **FORGET SAVED PROFILE**, which deletes that player's profile, IP record, and linked match records. The IP retention default is 30 days after the last multiplayer connection. If you change the policy or retention setting, update the notice shown in the UI as well.

### Inspect saved player records

In the database SQL editor, run the following query to view the latest profiles. Treat `last_ip` as private data and do not share screenshots or exports containing it:

```sql
SELECT display_name, last_ip, first_seen, last_seen, matches_played, wins, losses
FROM chase_players
ORDER BY last_seen DESC;
```

To view recent match outcomes without exposing IP addresses:

```sql
SELECT winner_role, round_number, completed_at
FROM chase_matches
ORDER BY completed_at DESC
LIMIT 50;
```

## Private administrator dashboard

Open `https://chasebackend-9loz.onrender.com/admin` after deployment. The dashboard itself shows no player records until an administrator signs in. The player, IP, match-summary, and match-list APIs require a valid server-side admin session; admin credentials are never embedded in either HTML file.

In Render → the `chasebackend-9loz` Web Service → **Environment**, set these two secret environment variables:

- `ADMIN_USERNAME` — defaults to `MacMonster` in the backend; set this variable only if you want to override it.
- `ADMIN_PASSWORD` — set this to your private administrator password.

Enter the password directly in the Render dashboard; do not paste it into `server.js`, the HTML, `.env.example`, or GitHub. The username is not a password and may be stored as configuration, but the password must remain private. Saving environment changes triggers a restart/redeploy. The login endpoint has rate limiting, compares secrets using constant-time comparison, and sets an HttpOnly, Secure-in-production, SameSite=Strict session cookie. Admin sessions last up to eight hours or until logout/redeploy.

If the password has been shared publicly or you suspect it may have been exposed, change it in Render before continuing.

## Option A — Run locally first

1. Install Node.js 20 or newer from <https://nodejs.org/>.
2. Extract this folder and open a terminal in the `chase_exe_backend` folder.
3. Run:

   ```bash
   npm install
   npm start
   ```

4. Open `http://localhost:3000`. Choose Find Match in one browser, then Find Match in a second browser to pair automatically. You can also create a private room and join it with a code.
5. The health endpoint is `http://localhost:3000/health`.

For local multiplayer from a second device on the **same Wi-Fi**, use the computer's LAN IP, for example `ws://192.168.1.20:3000/ws`, in the game's **Connection setup**. Allow Node.js through the computer's firewall for private networks. Do not expose this unencrypted `ws://` local test server to the public internet.

## Option B — Deploy the backend publicly on Render

Render supports inbound WebSocket connections on web services. Free web services may sleep after 15 minutes with no inbound HTTP/WebSocket messages; this game sends a WebSocket heartbeat while open, but after everyone closes it, the first later connection may take about a minute to wake up. See Render's current docs: <https://render.com/docs/websocket> and <https://render.com/docs/free>.

1. Create a GitHub repository, for example `chase-exe-backend`.
2. Upload the package contents to the repository root. Upload `server.js`, `package.json`, `.env.example`, `render.yaml`, `README.md`, and the `public` folder containing both `index.html` and `admin.html`. Do **not** upload `node_modules`.
3. In Render, select **New + → Web Service**, connect the GitHub repository, and create the service.
4. Use these settings if asked:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Plan:** Free for testing
   - **Root directory:** leave blank if the files are in the repository root
5. Leave `ALLOWED_ORIGINS` unset/blank for your first test. If you later set it, enter a comma-separated list of exact page origins (for example, `https://your-service.onrender.com`). Origins are not URLs with `/ws` paths.
6. Wait for the deployment to finish. Render gives you a URL like `https://your-service.onrender.com`.
7. Open that URL. The page detects the matching secure WebSocket URL automatically. Choose **Find Match** on both devices to pair automatically, or create a private room and share the code.

## Option C — Keep the game page in ESP32 LittleFS

1. Copy `public/index.html` into your Arduino project's `data/chase.html` if your existing website already uses `index.html`. If the game should be the homepage, copy it to `data/index.html` instead.
2. Upload the LittleFS filesystem to the ESP32.
3. Waiting invite/random-match panels automatically expire after 120 seconds by default (`ROOM_WAIT_TIMEOUT_MS`). The current game HTML is preconfigured to connect to `wss://chasebackend-9loz.onrender.com/ws`. There is no backend settings panel in the player UI. The game view is centered with document scrolling disabled, the camera follows the local player through the larger woodland map, mobile devices use an analog virtual joystick plus sprint, and Find Match places players into random open waiting rooms. The player consent/profile form opens as a compact modal rather than occupying the lobby layout.
4. Open the game from your ESP32 website, create a room, and share the code or invite link.

When the other player is offline, the game stays in a waiting state instead of showing a false round countdown. The runner can use **INVITE PLAYER** to copy the invite. The backend accepts a replacement catcher when the previous catcher disconnected after a finished round.

## Update the existing Render deployment

To apply the waiting-screen fix to the Render backend at `https://chasebackend-9loz.onrender.com/`:

1. Replace `server.js`, `package.json`, `.env.example`, `render.yaml`, `README.md`, `public/index.html`, and `public/admin.html` with the matching files from this package. Do not add a `.env` file or database password to GitHub.
2. In Command Prompt at the root of your existing repository, run:

   ```cmd
   git add server.js package.json .env.example render.yaml README.md public/index.html public/admin.html
   git commit -m "Add persistent player memory and invite timeout"
   git push origin main
   ```

3. In Render, create a PostgreSQL database and add its **Internal Database URL** to the web service as the secret environment variable `DATABASE_URL`. Save and deploy; the server creates the tables automatically.
4. Wait for Render to finish redeploying, then check `/health` for `storage.enabled: true`.
5. Separately upload `public/index.html` to the ESP32 LittleFS `data` folder as described above. Re-deploying Render does not update the copy saved in ESP32 flash.

**Important remote-access distinction:** if your ESP32 website is only available at a private URL such as `http://192.168.1.20`, a friend on another network cannot open that page. The backend makes the *game session* reachable, but it does not automatically publish the ESP32 web server. For remote play, either both players open the public Render URL (the easiest option; Render serves the same game page), or make your ESP32 website publicly reachable through a secure remote-access setup you already control.

## Optional origin restriction

After testing, you can add a Render environment variable named `ALLOWED_ORIGINS`. Use comma-separated origins such as:

```text
ALLOWED_ORIGINS=https://your-service.onrender.com,https://your-public-game-domain.example
```

If you serve the HTML from an ESP32 public domain, add that page's exact origin too. Avoid guessing origins; a mismatch will cause WebSocket connections to be rejected. Leave this blank while setting up, then configure it once the final page URL is known.

## Game controls

- Desktop: WASD or arrow keys; hold Shift to sprint.
- Mobile: drag the virtual joystick in any direction and hold Sprint. The compact lobby and game are designed not to show a page scrollbar; on very short landscape screens, use fullscreen for more room.
- Runner wins if the timer expires; catcher wins by tagging the runner.

This is a lightweight casual-game backend, not a hardened commercial matchmaking service. It includes random room codes, per-session authorization, basic room-creation throttling, bounds/obstacle checks, and server-side catch/timer validation. For a large public launch, add stronger rate limiting, monitoring, and abuse controls.


## Free Google Search setup (SEO)

The public Render copy now includes a descriptive page title and meta description, Open Graph metadata, VideoGame JSON-LD, `/robots.txt`, and `/sitemap.xml`. The HTML served at `/` is the page intended for public search discovery. A private ESP32 address such as `192.168.x.x` is not publicly crawlable.

1. Push the updated `public/index.html`, `public/robots.txt`, `public/sitemap.xml`, and `public/admin.html` to GitHub and wait for Render to deploy.
2. Open `https://chasebackend-9loz.onrender.com/robots.txt` and `https://chasebackend-9loz.onrender.com/sitemap.xml` to confirm they load.
3. Open Google Search Console at `https://search.google.com/search-console/` and add a URL-prefix property for `https://chasebackend-9loz.onrender.com/`.
4. Choose the HTML-tag ownership verification method. Copy the exact `google-site-verification` meta tag Google gives you into the `<head>` of `public/index.html`, commit and push it, wait for Render to redeploy, then complete verification. Do not invent or reuse someone else's verification token.
5. In Search Console, open URL Inspection for `https://chasebackend-9loz.onrender.com/` and choose Request Indexing. Then submit `https://chasebackend-9loz.onrender.com/sitemap.xml` under Sitemaps.
6. Keep useful laptop/mobile instructions visible on the landing page and share the public game page from relevant project pages and communities. Search indexing and rank are not guaranteed, and no one can guarantee a #1 position.


## Lobby display fix

The latest `public/index.html` keeps **Find Match**, **Create Private Room**, and **Join Room with an 8-character code** visible at desktop and mobile widths. The Quick Start instructions are collapsible to preserve space for the matchmaking controls. The lobby hides its scrollbar but can still scroll on short screens; active gameplay remains a fixed no-scroll view.
