# Human Nature Stories Studio course landing page

## Laptop requirements

Install Node.js 18 or newer from https://nodejs.org/ before starting.

## Run locally

1. Copy `.env.example` to `.env`.
2. For checking first, put your Razorpay **Test Mode** `Key ID` and `Key Secret` in `.env`. Test Key IDs start with `rzp_test_`. Never paste the secret into `index.html`.
3. Set `COURSE_PRICE_INR` to the amount you want to charge.
4. Install and start the server:

```bash
npm install
npm start
```

## Connect Supabase

1. Open the Supabase SQL Editor.
2. Run the SQL in `supabase-schema.sql`.
3. Add the project URL and **service_role** key to `.env` as `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
4. Restart the server and click **Check Supabase connection** on the page.

The server records each verified Razorpay payment in `course_purchases`. Keep the service_role key only in `.env`; never put it in `index.html` or expose it to the browser.

Do not double-click `index.html`, because that opens it as a `file://` page and the payment API will not be available. Always open `http://localhost:3000` after starting the server.

On Windows, double-click `start-windows.bat`. On macOS or Linux, run `./start-mac-linux.sh` from this folder.

Click **Check Razorpay connection** on the page. A successful result confirms that the server can authenticate with Razorpay. Complete a test checkout using Razorpay Test Mode before switching to Live Mode credentials, which start with `rzp_live_`.

## Add the course PDF and video

Put your files inside the `course-content` folder. For example:

```text
course-content/human-nature-stories-course.pdf
course-content/human-nature-stories-course.mp4
```

The checked-in `Viral-Reel-Process.mp4` currently is a Git LFS pointer, not the video bytes. Install Git LFS and run `git lfs pull` before deploying; in Vercel, enable Git LFS for the project so the build receives the actual media. Verify the materialized file is an MP4 (not a short text pointer) before shipping. The server omits LFS pointer files from the course listing and refuses to stream them as if they were videos.

After a successful payment, the server verifies the Razorpay signature, saves the purchase in Supabase, sets an HTTP-only buyer cookie, and redirects the buyer to `/success`. The success route and each protected content request hash the cookie token and check that its matching `course_purchases` row has `status = 'paid'` and has not expired. If Supabase cannot confirm a paid purchase, the page and files are denied. The success page shows PDF download links and an embedded MP4 player. Files in `course-content` are not served as public static files. Buyer sessions expire after 24 hours. The server stores only a SHA-256 hash of each buyer token in Supabase and checks the matching paid purchase and expiry on every success-page or file request. Access therefore continues across Vercel serverless instances and restarts; the raw token exists only in the buyer's HttpOnly cookie.

The browser calls `/api/create-order`; the server records a pending order and gives the buyer a short-lived HttpOnly access cookie before opening checkout. After checkout, `/api/verify-payment` verifies Razorpay's checkout signature and updates that exact pending order. The `/api/razorpay-webhook` endpoint is the durable fallback: configure a Razorpay `payment.captured` webhook to this URL and set the matching `RAZORPAY_WEBHOOK_SECRET` in the server environment. The webhook verifies the raw-body HMAC, checks order amount/currency, and marks the existing pending order paid. Both paths are idempotent for the same order/payment. Supabase writes require `SUPABASE_SERVICE_ROLE_KEY`; never use the anon key or expose the service key in browser code. The video endpoint supports byte-range requests for playback and seeking. Use HTTPS in production; the buyer cookie is marked `Secure` when `NODE_ENV=production`.

For production, deploy `server.js` as a Node service, set the environment variables in the host dashboard, and set `FRONTEND_ORIGIN` to the exact public site origin.

# deepthoughts
