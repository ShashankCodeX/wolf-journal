# Edgebook — account-based trading journal

Edgebook is a static trading journal for forex and crypto trades. Anyone can create an account with their own email and password. Trades and screenshots are stored in Supabase and scoped to the signed-in account by database row-level security (RLS). Screenshots are stored in a private bucket.

## Live site

The current site is [wolf-journal.netlify.app](https://wolf-journal.netlify.app/). Sign up or sign in there with email and password. Each trader uses their own account; do not share accounts.

## Public repository and credentials

This project uses a Supabase **publishable** key in `config.js`. Publishable keys (and the project URL) are designed to be visible in browser applications, so they are not secrets. Access to journal data is controlled by the RLS policies in `supabase/schema.sql` and the private Storage policies.

Never add a Supabase **secret** key or legacy `service_role` key, database password, Netlify token, or personal login credentials to this repository. The `.gitignore` excludes local virtual environments and common local configuration/secrets. Review staged files before publishing.

## Supabase setup

The live Edgebook project already has its tables, RLS policies, and private screenshot bucket configured. If you are deploying your own separate instance:

1. Create a Supabase project.
2. Run all of `supabase/schema.sql` in its SQL Editor.
3. Set that project's URL and publishable key in `config.js`. Do not use a secret or `service_role` key.
4. In **Authentication → URL Configuration**, set the Site URL to your site's origin and add its auth callback URL to Redirect URLs. For local preview, allow `http://localhost:5500/**`. For the live site, allow `https://wolf-journal.netlify.app/**`.
5. In **Authentication → Sign In / Providers**, enable email sign-in. Email confirmation may be required depending on the project's settings.

## Local preview

The site has no build step or npm dependencies. With Python 3 installed, run this from the project folder:

```sh
python3 -m http.server 5500
```

Open [http://localhost:5500](http://localhost:5500). Do not open `index.html` directly; authentication requires serving the files over HTTP.

## Deploying changes to Netlify

The Netlify project is configured to publish the static files from the repository root. To connect the public GitHub repository, choose **Add new project → Import an existing project** in Netlify, select the repository, and use the production branch with no build command. The `netlify.toml` file sets the publish directory to `.`. For the existing site, connect this repository to the `wolf-journal` Netlify project so pushes deploy updates there.

If Netlify asks for a build command, leave it blank. After deployment, verify the production URL and keep the `wolf-journal.netlify.app` redirect URL in Supabase.

## Backups and privacy

- Download JSON to back up trades and screenshots; download CSV for trade details.
- Supabase Auth associates each trade and screenshot with its owner. Row-level security prevents one signed-in account from reading or changing another account's rows.
- Keep the screenshot bucket private. Do not disable or weaken the RLS and Storage policies.
- A public website and repository do not make journals public; never add server-side credentials or disable the access policies.
