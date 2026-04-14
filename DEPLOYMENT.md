# Danab Multi-Station Deployment Guide

## Your Current Stations

You have **5 stations** that will be served from one deployment:

| Station # | Name | IMEI | Custom Domain |
|-----------|------|------|---------------|
| 58 | Castello Taleex | WSEP161721195358 | station58.danab.com |
| 59 | Castello Boondhere | WSEP161741066502 | station59.danab.com |
| 60 | Java Taleex | WSEP161741066503 | station60.danab.com |
| 61 | Java Airport | WSEP161741066504 | station61.danab.com |
| 62 | Dilek Somalia | WSEP161741066505 | station62.danab.com |

## Step-by-Step Deployment

### 1. Deploy to Vercel

```bash
# Install Vercel CLI if you haven't
npm i -g vercel

# Deploy
cd c:\Users\Abdifth\Desktop\nexjsmovement\DanabN
vercel deploy --prod
```

### 2. Add Environment Variables in Vercel Dashboard

Go to your Vercel project → Settings → Environment Variables and add:

#### Firebase
```
FIREBASE_CREDENTIALS_B64=your_base64_firebase_service_account_here
```

#### Waafi Payment
```
WAAFI_API_KEY=your_waafi_api_key_here
WAAFI_API_USER_ID=your_waafi_api_user_id_here
WAAFI_MERCHANT_UID=your_waafi_merchant_uid_here
WAAFI_URL=https://api.waafipay.com/asm
```

#### HeyCharge
```
HEYCHARGE_API_KEY=your_heycharge_api_key_here
HEYCHARGE_DOMAIN=https://openapi.heycharge.global
```

#### Station IMEIs
```
STATION_58_IMEI=WSEP161721195358
STATION_59_IMEI=WSEP161741066502
STATION_60_IMEI=WSEP161741066503
STATION_61_IMEI=WSEP161741066504
STATION_62_IMEI=WSEP161741066505
```

#### Optional
```
PORT=3000
```

### 3. Add Custom Domains in Vercel

In Vercel Dashboard → Settings → Domains, add these 5 domains:

1. `station58.danab.com`
2. `station59.danab.com`
3. `station60.danab.com`
4. `station61.danab.com`
5. `station62.danab.com`

### 4. Configure DNS Records

In your domain registrar (where you bought `danab.com`), add these CNAME records:

```
Host: station58    Type: CNAME    Value: cname.vercel-dns.com
Host: station59    Type: CNAME    Value: cname.vercel-dns.com
Host: station60    Type: CNAME    Value: cname.vercel-dns.com
Host: station61    Type: CNAME    Value: cname.vercel-dns.com
Host: station62    Type: CNAME    Value: cname.vercel-dns.com
```

### 5. Generate QR Codes for Each Station

Create QR codes pointing to:

- **Castello Taleex**: `https://station58.danab.com`
- **Castello Boondhere**: `https://station59.danab.com`
- **Java Taleex**: `https://station60.danab.com`
- **Java Airport**: `https://station61.danab.com`
- **Dilek Somalia**: `https://station62.danab.com`

Print and place each QR code at its respective station.

## How It Works

When a customer scans the QR code:

1. **Station 58 (Castello Taleex)**: 
   - Customer visits `station58.danab.com`
   - App detects "58" from domain
   - Uses `STATION_58_IMEI=WSEP161721195358`
   - Logs rental with station code "58"

2. **Station 59 (Castello Boondhere)**:
   - Customer visits `station59.danab.com`
   - App detects "59" from domain
   - Uses `STATION_59_IMEI=WSEP161741066502`
   - Logs rental with station code "59"

And so on for all stations...

## Adding More Stations

When you expand to 20 stations:

1. Add new environment variable: `STATION_63_IMEI=your_new_imei`
2. Add custom domain: `station63.danab.com`
3. Add DNS CNAME: `station63 → cname.vercel-dns.com`
4. Generate QR code for `https://station63.danab.com`

**No code changes needed!**

## Testing

Test each station URL:
- https://station58.danab.com → Should show payment page
- https://station59.danab.com → Should show payment page
- https://station60.danab.com → Should show payment page
- https://station61.danab.com → Should show payment page
- https://station62.danab.com → Should show payment page

Each should process payments and log the correct station code in Firebase.
