# JC's Junk Removal — Team Area (jcjunk.space/admin)

Built the same way as the Black Wolf Tattoo Club inbox: Vercel functions, Upstash Redis, and the same login system (own email + password, roles, Team screen, reset links, shop key). **Claude** reads job photos on the server, so its key is never shown to the crew. Gemini can be used instead by setting a Gemini key and leaving the Claude key out.

## What's here
| Address | What it does |
|---|---|
| `/admin` | Sign in, dashboard, change my password |
| `/admin/estimate` | Estimate Builder: photos + description → AI suggests a load size → price → save, copy text, PDF |
| `/admin/estimate#saved` | Every saved estimate, searchable, with status (Draft / Sent / Accepted / Declined / Completed) |
| `/admin/estimate#prices` | Owner only: load-size prices, add-ons, tax, range, company info, terms |
| `/admin/team` | Owner only: add the crew, turn logins off, reset passwords |

Server code: `api/admin/login.js` (logins + team), `api/admin/estimates.js` (estimates + prices), `api/admin/analyze.js` (AI photo reader: Claude, or Gemini as a backup). Shared helpers are in `api/_lib/`. That's 3 functions, well under Vercel's limit.

## Roles
- **Owner / Site admin:** everything, including Team and Prices
- **Crew:** make, save and edit estimates, and delete their own

## One-time setup (about 10 minutes, all free)
1. **Database:** connect the Upstash Redis database Black Wolf already uses. Vercel → **Storage** → that database → **Connect Project → jc-junk-removal**, for **Production and Preview**. JC's data is kept under its own `jcjunk:` prefix. (A new free Upstash database also works.)
2. **Claude key:** go to **console.anthropic.com** and sign in. A Console account is separate from your claude.ai plan.
   - **Billing:** buy a small amount of prepaid credits. Leave auto-reload off, so it can never spend more than you load.
   - **API keys → Create key:** name it `jcjunk-estimates`, then copy it.
3. **Environment variables:** Vercel → Settings → Environment Variables. Add each for Production and Preview:
   - `ADMIN_PASSWORD`: the "shop key" for first sign-in and emergency recovery. Use something long.
   - `SESSION_SECRET`: any long random text (30+ characters). It keeps sign-ins secure.
   - `ANTHROPIC_API_KEY`: the key from step 2.
   - *(Optional, for "Forgot password" emails)* `RESEND_API_KEY` and `EMAIL_FROM` (e.g. `JC's Junk Removal <team@jcjunk.space>`), with the domain verified in Resend. These are the same as Black Wolf's. Without them, owners make reset links on the Team screen and text them to the person.
4. **Deploy** (merge this branch into `main`).
5. **First sign-in:** open **jcjunk.space/admin**, leave email blank, and enter the shop key. Open **Team** and add JC (Owner), yourself (Site admin) and the crew.
6. Open **Prices** and replace the placeholder prices with JC's real rates and phone number.
7. Change `ADMIN_PASSWORD` in Vercel to something only you know. It stays as the way back in if every password is lost.

## Good to know
- **Photos:** sent to Anthropic only when someone taps Analyze, and not stored by the site. Anthropic doesn't train on API data by default.
- **AI limits:** each person can run 40 photo checks per hour. If the prepaid credits run out, the app says "AI credits have run out", and the crew picks the size by hand until you top up.
- **AI model:** the server uses `claude-haiku-5-5` (fast, inexpensive, reads photos) and moves to `claude-sonnet-5-5` automatically if that name is ever retired. To pin a model, set `ANTHROPIC_MODEL` in Vercel.
- **Gemini instead:** remove `ANTHROPIC_API_KEY` and add `GEMINI_API_KEY`. Note that the artemis.nealmedia Google account has Gemini's free tier blocked.
- **Data separation:** everything is stored under the `jcjunk:` prefix, so a shared Redis database won't mix JC's data with another site's.
- **Turning someone off** signs them out everywhere right away. Their estimates stay.
