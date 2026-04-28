# Coaster's Cabs Website

This is a complete website for Coaster's Cabs with a local frontend and backend.

## Included files

- `index.html` - full responsive website with styling, interactive map, route estimate, booking form, WhatsApp quote link, and trip progress display.
- `server.js` - Express backend with geocode, routing, and booking APIs.
- `data/bookings.json` - local booking storage file.
- `assets/coasters-cabs-logo.png` - supplied Coaster's Cabs logo.
- `README.md` - setup notes.
- `CONTACT.txt` - contact details.

## How to run locally

1. Install dependencies:
	npm install
2. Start backend API:
	npm start
3. Start frontend static server in another terminal:
	py -m http.server 5500
4. Open:
	http://localhost:5500

The backend runs on http://localhost:8787.

## Booking form behavior

- Booking requests are submitted to `POST /api/bookings`.
- Saved requests are appended to `data/bookings.json`.
- You can optionally forward each booking to a webhook by setting `BOOKING_WEBHOOK_URL` before starting the backend.

## How to publish

Upload the full folder to any static hosting provider, cPanel public_html folder, Netlify, Vercel, GitHub Pages, or similar hosting.

## Important pricing note

The fare estimator uses public map services and local pricing logic to provide a guide price. Live Uber, Bolt, or other ride-service prices require official API access or a backend integration.
