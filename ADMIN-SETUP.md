# JC's Junk Removal — Team Area (jcjunk.space/admin)

Built the same way as the Black Wolf Tattoo Club inbox: Vercel functions, Upstash Redis, and the same login system (own email + password, roles, Team screen, reset links, shop key). Gemini reads job photos on the server, so its key is never shown to the crew.

## What's here
| Address | What it does |
|---|---|
| `/admin` | Sign in, dashboard, change my password |
| `/admin/estimate` | Estimate Builder: photos + description → AI suggests a load size → price → save, copy text, PDF |
| `/admin/estimate#saved` | Every saved estimate, searchable, with status (Draft / Sent / Accepted / Declined / Completed) |
| `/admin/estimate#prices` | Owner only: load-size prices, add-ons, tax, range, company info, terms |
| `/admin/team` | Owner only: add the crew, turn logins off, reset passwords |

Server code: `api/admin/login.js` (logins + team), `api/admin/estimates.js` (estimates + prices), `api/admin/analyze.js` (Gemini). Shared helpers are in `api/_lib/`. That's 3 functions, well under Vercel's limit.

## Roles
- **Owner / Site admin:** everything, including Team and Prices
- **Crew:** make, save and edit estimates, and delete their own

## One-time setup (about 10 minutes, all free)
1. **Database:** Vercel → the jcjunk.space project → **Storage → Create → Upstash for Redis** (free plan) → connect it to this project for **Production and Preview**. Vercel adds the connection settings by itself.
2. **Gemini key:** go to **aistudio.google.com → Get API key → Create API key**, then copy it.
3. **Environment variables:** Vercel → Settings → Environment Variables. Add each for Production and Preview:
   - `ADMIN_PASSWORD`: the "shop key" for first sign-in and emergency recovery. Use something long.
   - `SESSION_SECRET`: any long random text (30+ characters). It keeps sign-ins secure.
   - `GEMINI_API_KEY`: the key from step 2.
   - *(Optional, for "Forgot password" emails)* `RESEND_API_KEY` and `EMAIL_FROM` (e.g. `JC's Junk Removal <team@jcjunk.space>`), with the domain verified in Resend. These are the same as Black Wolf's. Without them, owners make reset links on the Team screen and text them to the person.
4. **Deploy** (merge this branch into `main`).
5. **First sign-in:** open **jcjunk.space/admin**, leave email blank, and enter the shop key. Open **Team** and add JC (Owner), yourself (Site admin) and the crew.
6. Open **Prices** and replace the placeholder prices with JC's real rates and phone number.
7. Change `ADMIN_PASSWORD` in Vercel to something only you know. It stays as the way back in if every password is lost.

## Good to know
- **Photos:** sent to Google only when someone taps Analyze, and not stored by the site. On Gemini's free tier, Google may use what's sent to improve its models.
- **AI limits:** each person can run 40 photo checks per hour. If Google's free daily limit runs out, the app says so, and the crew picks the size by hand.
- **AI model:** the server tries `gemini-flash-latest`, then older models. To pin one, set `GEMINI_MODEL` in Vercel.
- **Data separation:** everything is stored under the `jcjunk:` prefix, so a shared Redis database won't mix JC's data with another site's.
- **Turning someone off** signs them out everywhere right away. Their estimates stay.
