# Putting SignFlow on the internet (plain-language guide)

SignFlow is already a website — these steps move it from your computer to the
internet so anyone can open it. You need two free accounts and about 30–45
minutes. No coding.

## Step 1 — Put the code on GitHub (free account)

GitHub is like Google Drive for app code. Hosting services fetch your app from it.

1. Go to github.com and create a free account.
2. Click the "+" (top right) → "New repository". Name it `signflow`,
   choose **Private**, click "Create repository".
3. On the next page click "uploading an existing file", drag the whole
   contents of your signflow folder in (everything EXCEPT any
   `node_modules` or `dist` folders if present, and NOT your `.env` file —
   that has your email password in it), and click "Commit changes".

## Step 2 — Host it on Render (free account)

Render runs your app on their computers and gives it an https address.

1. Go to render.com and sign up (easiest: "Sign up with GitHub").
2. Click "New +" → "Blueprint" → connect your `signflow` repository → Apply.
   Render reads the `render.yaml` file in the project and sets everything up.
3. That's the whole server side. Email, sign-in providers and access rules are
   set up in the browser afterwards (first account → setup wizard → Admin).
4. Wait for the deploy to finish (a few minutes). Open the address — you'll
   see the SignFlow login screen. That address now works for everyone,
   everywhere, phones included.
5. **Check the health page**: open `https://your-address/api/health`. It must
   say `"storage_is_persistent_disk": true` and `"warnings": []`. If it warns
   about storage, the disk is missing: in the service go to **Disks → Add
   Disk** (mount path `/opt/render/project/src/server/data-disk`, 1 GB) and in
   **Environment** add `STORAGE_DIR` with that same path. Without this, every
   deploy erases all accounts and documents.

### About the cost

The config uses Render's **Starter** plan (about US$7/month) because it includes
a persistent disk — your signed documents and accounts survive restarts.
Render's free plan works for a demo, but it has no disk: documents and
accounts are ERASED whenever the service restarts, which is not acceptable
for real signed contracts. Truly-free-forever with safe storage means an
Oracle Cloud "Always Free" server, which needs a developer for an hour —
the README has notes for them.

## Step 3 — (optional) Your own address

In Render → Settings → Custom Domains you can attach `sign.softshala.com`.
Whoever manages the softshala.com domain adds one DNS record (Render shows
exactly what). Then update APP_URL to the new address.

## After the first deploy

Open the address, create the first account — it becomes the platform operator —
and follow the setup wizard: platform name, email sender (with a test button),
and optionally the Microsoft and Google apps. Everything can be revisited under
**Admin**. Users then connect their own inbox and drive from Settings.

## Afterwards

- You and colleagues: open the address, create accounts, send documents.
- Signers: just click the link in their email — no account needed.
- The app updates itself whenever you upload new code to GitHub.
