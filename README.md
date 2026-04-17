# Danab Power Bank Station Management System

This is a [Next.js](https://nextjs.org) application for managing Danab power bank charging stations.

## Multi-Station Deployment with Custom Domains

This single codebase supports **unlimited stations** using custom domains. Deploy once, serve all stations with unique URLs.

### 🎯 How It Works

Each station gets its own URL (e.g., `station58.danab.com`, `station59.danab.com`). The application automatically detects which station based on the domain name and serves the correct configuration.

### 📋 Setup Instructions

#### Step 1: Deploy to Vercel (or similar platform)

```bash
# Deploy your codebase once
vercel deploy
```

#### Step 2: Configure Environment Variables

In your Vercel dashboard (or `local.env` for local development), add:

```bash
# Station IMEIs - one for each station
STATION_58_IMEI=your_castello_taleex_imei
STATION_59_IMEI=your_station_59_imei
STATION_60_IMEI=your_station_60_imei
STATION_61_IMEI=your_station_61_imei
# Add more as needed: STATION_62_IMEI, STATION_63_IMEI, etc.

# HeyCharge API
HEYCHARGE_API_KEY=your_api_key
HEYCHARGE_DOMAIN=https://api.heycharge.com
```

#### Step 3: Add Custom Domains

In Vercel Dashboard → Settings → Domains, add:

- `station58.danab.com` → Points to your deployment
- `station59.danab.com` → Points to your deployment
- `station60.danab.com` → Points to your deployment
- `station61.danab.com` → Points to your deployment

#### Step 4: Configure DNS

In your domain registrar (e.g., Namecheap, GoDaddy), add CNAME records:

```
station58  →  cname.vercel-dns.com
station59  →  cname.vercel-dns.com
station60  →  cname.vercel-dns.com
station61  →  cname.vercel-dns.com
```

### 🔗 Customer Experience

**Station 58 (Castello Taleex):**

- URL: `https://station58.danab.com`
- QR Code → Directs to station58.danab.com
- Automatically uses Station Code: `58` and its IMEI

**Station 59:**

- URL: `https://station59.danab.com`
- QR Code → Directs to station59.danab.com
- Automatically uses Station Code: `59` and its IMEI

**And so on for all stations...**

### ✅ Benefits

- ✨ **One Deployment** - Manage all stations from single codebase
- 🔗 **Unique URLs** - Each station has professional branded URL
- 📱 **Easy QR Codes** - Generate QR codes pointing to each station's URL
- 🚀 **Scalable** - Add new stations by just adding env var and domain
- 💰 **Cost Effective** - No need for multiple deployments

### 🆕 Adding New Stations

To add Station 62:

1. Add environment variable: `STATION_62_IMEI=new_station_imei`
2. Add custom domain: `station62.danab.com`
3. Add DNS CNAME: `station62 → cname.vercel-dns.com`
4. Generate QR code for `https://station62.danab.com`

That's it! No code changes needed.

## Getting Started

First, configure your environment, then run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

# DanabN
"# Danab" 
"# Danab" 
