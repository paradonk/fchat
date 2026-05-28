# Family Chat — Deployment Guide
# Site: data-civil.com

Follow every step in order. The whole process takes about 15–20 minutes.

---

## STEP 1 — Upload files via FTP

Connect via FTP and upload the **entire `fchat` folder** to:

```
/domains/data-civil.com/public_html/private/fchat/
```

**Skip these — do NOT upload:**

| Skip this | Reason |
|---|---|
| `node_modules/` folder | Too large — will be installed on server |
| `.env` file | Contains secrets — you will create it in Step 4 |

Also do not upload `localhost+1.pem` or `localhost+1-key.pem`; they are local HTTPS certificates and cPanel handles HTTPS before the Node app.

Everything else should be uploaded.

---

## STEP 2 — Create MySQL database in cPanel

1. Log in to **cPanel**
2. Go to **MySQL Databases**
3. Under **Create New Database** → type `fchat` → click **Create Database**
   - Result: `datacivi_fchat` ✓ (already set in schema.sql)
4. Under **MySQL Users → Add New User** → type username `fchat` and a strong password → click **Create User**
   - Result: `datacivi_fchat`
5. Under **Add User to Database** → select `datacivi_fchat` user and `datacivi_fchat` database → click **Add**
6. Tick **ALL PRIVILEGES** → click **Make Changes**

---

## STEP 3 — Import the database schema

1. In cPanel go to **phpMyAdmin**
2. Click **`datacivi_fchat`** in the left panel
3. Click the **Import** tab
4. Click **Choose File** → select `schema.sql` from your computer
5. Click **Go**
6. You should see a green success message

---

## STEP 4 — Create the .env file and upload it

On your Windows PC, open Notepad and paste the text below.
Replace the values marked with `← REPLACE`:

```
SESSION_SECRET=← REPLACE with a long random string (get one from https://generate-secret.vercel.app/48)
DB_HOST=localhost
DB_PORT=3306
DB_USER=datacivi_fchat
DB_PASSWORD=← REPLACE with the password you set in Step 2
DB_NAME=datacivi_fchat
PORT=3000
NODE_ENV=production
PUBLIC_BASE_PATH=/private/fchat
```

Save as `.env`:
- File → Save As
- Change "Save as type" to **All Files**
- Filename: `.env`
- Click Save

Upload this `.env` file via FTP to:
```
/domains/data-civil.com/public_html/private/fchat/.env
```

---

## STEP 5 — Set up Node.js App in cPanel

1. In cPanel find **"Setup Node.js App"** (under Software section)
2. Click **Create Application**
3. Fill in:

| Field | Value |
|---|---|
| Node.js version | **20** (or highest available) |
| Application mode | **Production** |
| Application root | `domains/data-civil.com/public_html/private/fchat` |
| Application URL | `data-civil.com/private/fchat` |
| Application startup file | `server.js` |

4. Click **Create**

---

## STEP 6 — Install packages

On the same Node.js App page, click **"Run NPM Install"**.

Wait 1–2 minutes for it to finish.

---

## STEP 7 — Start the app

Click the **Start** button.

Open your domain in a browser — the login page should appear.

---

## STEP 8 — Test everything

1. Register an account and log in
2. Send a text message — should appear on the right
3. Open an incognito window, register a second account — messages from the other account should appear on the LEFT
4. Send an image — should upload and display
5. Send multiple images — should display as a grid

---

## Troubleshooting

**App does not start**
- cPanel → Node.js App → Stop → Start again
- Check the Logs / Stderr link for the error message
- Most common cause: wrong DB credentials in `.env`

**Real-time messages not working**
- Your host may block WebSocket connections
- Open `server.js`, find:
  ```js
  const io = new Server(server);
  ```
  Change to:
  ```js
  const io = new Server(server, {
    transports: ["polling", "websocket"]
  });
  ```
- Upload updated `server.js` via FTP → cPanel → Node.js App → **Restart**

**Images not uploading**
- Create an empty folder named `uploads` inside `fchat/` and upload it via FTP if it does not exist:
  ```
  /domains/data-civil.com/public_html/private/fchat/uploads/
  ```

**"Access denied" database error**
- Double-check the user `datacivi_fchat` has ALL PRIVILEGES on database `datacivi_fchat` in MySQL Databases

---

## Your specific paths (reference)

```
App folder:    /domains/data-civil.com/public_html/private/fchat/
Uploads:       /domains/data-civil.com/public_html/private/fchat/uploads/
.env file:     /domains/data-civil.com/public_html/private/fchat/.env
Database:      datacivi_fchat
DB user:       datacivi_fchat
```

---

## Ongoing maintenance

| Task | How |
|---|---|
| Restart after uploading changes | cPanel → Node.js App → Restart |
| View errors | cPanel → Node.js App → Logs / Stderr |
| Back up images | FTP → download `uploads/` folder regularly |
| Back up database | cPanel → Backup → download MySQL backup for `datacivi_fchat` |
