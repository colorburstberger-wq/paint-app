# Phone-only deployment notes

This ZIP is flattened and ready for the GitHub repo root.

Recommended phone-only method:
1. Open GitHub repo in browser.
2. Create a Codespace.
3. Upload this ZIP into the Codespace.
4. Run:
   unzip paint-app-vercel-ready-source.zip -d /tmp/paint-app
   cp -r /tmp/paint-app/* .
   cp -r /tmp/paint-app/.[!.]* . 2>/dev/null || true
   npm install
   npm run build
   git add .
   git commit -m "Add rental services Vite app"
   git push
5. Import the GitHub repo into Vercel.
