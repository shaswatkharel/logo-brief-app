# Logo Brief App

Full-stack client onboarding system for logo designers.
Clients fill a premium brief → you get an instant email → manage everything in a private admin panel.

## Files
```
logo-brief-app/
├── server.js           ← Express backend
├── package.json
├── .env.example        ← Copy to .env and fill in
├── .gitignore
├── briefs.db           ← SQLite (auto-created)
└── public/
    ├── index.html      ← Client brief form (share this URL)
    └── admin.html      ← Your admin panel (/admin)
```

## Quick Start (local)
```bash
npm install
cp .env.example .env   # fill in your values
npm start
# Client form  → http://localhost:3000
# Admin panel  → http://localhost:3000/admin
```

## Environment Variables
| Variable        | Description                               |
|-----------------|-------------------------------------------|
| ADMIN_KEY       | Your admin panel password                 |
| DESIGNER_EMAIL  | Your email — briefs delivered here        |
| SMTP_HOST       | smtp.gmail.com                            |
| SMTP_PORT       | 587                                       |
| SMTP_USER       | Your Gmail address                        |
| SMTP_PASS       | Gmail App Password (16 chars)             |
| APP_URL         | Your live domain (optional)               |

### Gmail App Password
Google Account → Security → 2-Step Verification → App Passwords → create for Mail

## Deploy on Railway (easiest)
1. Push to GitHub
2. railway.app → New Project → Deploy from GitHub
3. Add all env vars in the Variables tab
4. Settings → Custom Domain → add your domain
5. Add a Volume at /app and change db path to /app/briefs.db for persistence

## Deploy on Render
1. Push to GitHub
2. render.com → New Web Service → connect repo
3. Build: `npm install` | Start: `node server.js`
4. Add env vars → add custom domain

## Deploy on VPS
```bash
npm install && cp .env.example .env
npm install -g pm2
pm2 start server.js --name logo-brief
pm2 save && pm2 startup
```
Nginx: proxy localhost:3000, then `certbot --nginx -d yourdomain.com`
