/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║         CSM DRIVE | ULTRA PRO — Cloudflare Worker v2                ║
 * ║         worker.js — Secure Upload Proxy + Google Photos Sync        ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║  ⚙️  SYMBOL BAR — ENVIRONMENT VARIABLES (Cloudflare Dashboard)      ║
 * ║  ─────────────────────────────────────────────────────────────────  ║
 * ║  ALLOWED_ORIGIN              → https://csm-storage.github.io        ║
 * ║  FIREBASE_PROJECT_ID         → photos-58c8e                         ║
 * ║                                                                      ║
 * ║  CLOUDINARY_CLOUD_NAME       → your Cloudinary cloud name           ║
 * ║  CLOUDINARY_UPLOAD_PRESET    → your unsigned/signed upload preset   ║
 * ║  CLOUDINARY_API_KEY          → your Cloudinary API key              ║
 * ║  CLOUDINARY_API_SECRET       → your Cloudinary API secret           ║
 * ║                                                                      ║
 * ║  GOOGLE_SERVICE_ACCOUNT_EMAIL → service account email               ║
 * ║  GOOGLE_PRIVATE_KEY           → service account private key (PEM)   ║
 * ║                                                                      ║
 * ║  GOOGLE_PHOTOS_CLIENT_ID      → OAuth2 client ID for Photos API     ║
 * ║  GOOGLE_PHOTOS_CLIENT_SECRET  → OAuth2 client secret                ║
 * ║  GOOGLE_PHOTOS_REFRESH_TOKEN  → long-lived refresh token            ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║  ROUTES                                                              ║
 * ║  POST /upload          — Upload image to Cloudinary + Google Photos ║
 * ║  GET  /drive/:fileId   — Stream Google Drive file (token-verified)  ║
 * ║  GET  /drive/:fileId/thumb — Serve thumbnail redirect               ║
 * ║  GET  /drive/:fileId?dl=1  — Force-download header                  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

/* ─── Entry Point ─────────────────────────────────────────────── */
export default {
    async fetch(request, env) {
        // ── CORS Preflight ──────────────────────────────────────
        if (request.method === 'OPTIONS') {
            return corsResponse('', 204, env);
        }

        const url  = new URL(request.url);
        const path = url.pathname;

        // ── Route: POST /upload ─────────────────────────────────
        if (path === '/upload' && request.method === 'POST') {
            return handleUpload(request, env);
        }

        // ── Route: GET /drive/:fileId[/thumb] ──────────────────
        if (path.startsWith('/drive/')) {
            return handleDriveProxy(request, url, path, env);
        }

        return corsResponse('Not found', 404, env);
    }
};

/* ═══════════════════════════════════════════════════════════════
   ROUTE: /upload
   1. Verify Firebase ID Token (Authorization: Bearer <token>)
   2. Upload to Cloudinary via REST API
   3. Sync to Google Photos
   4. Return JSON with cloudinary_url + google_photos_id
   ═══════════════════════════════════════════════════════════════ */
async function handleUpload(request, env) {
    // ── Step 1: Verify Firebase Token ──────────────────────────
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return corsResponse(JSON.stringify({ error: 'Unauthorized: no token' }), 401, env, 'application/json');
    }

    const tokenPayload = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
    if (!tokenPayload) {
        return corsResponse(JSON.stringify({ error: 'Unauthorized: invalid token' }), 401, env, 'application/json');
    }

    // ── Step 2: Parse multipart form data ──────────────────────
    let formData;
    try {
        formData = await request.formData();
    } catch (e) {
        return corsResponse(JSON.stringify({ error: 'Invalid form data' }), 400, env, 'application/json');
    }

    const file       = formData.get('file');
    const customName = formData.get('customName') || '';
    const folder     = formData.get('folder') || '';
    const syncPhotos = formData.get('syncGooglePhotos') === 'true';

    if (!file || typeof file === 'string') {
        return corsResponse(JSON.stringify({ error: 'No file provided' }), 400, env, 'application/json');
    }

    const fileBuffer  = await file.arrayBuffer();
    const fileBytes   = new Uint8Array(fileBuffer);
    const contentType = file.type || 'application/octet-stream';
    const fileName    = customName || file.name || 'upload';

    // ── Step 3: Upload to Cloudinary ───────────────────────────
    let cloudinaryResult;
    try {
        cloudinaryResult = await uploadToCloudinary(fileBytes, contentType, fileName, folder, env);
    } catch (e) {
        return corsResponse(JSON.stringify({ error: 'Cloudinary upload failed: ' + e.message }), 502, env, 'application/json');
    }

    // ── Step 4: Sync to Google Photos (optional) ───────────────
    let googlePhotosResult = null;
    if (syncPhotos && env.GOOGLE_PHOTOS_REFRESH_TOKEN) {
        try {
            googlePhotosResult = await syncToGooglePhotos(fileBytes, contentType, fileName, env);
        } catch (e) {
            // Non-fatal: log but don't fail the whole upload
            console.warn('[GooglePhotos] Sync failed:', e.message);
            googlePhotosResult = { error: e.message };
        }
    }

    // ── Step 5: Return result ───────────────────────────────────
    const result = {
        success:       true,
        cloudinary_url: cloudinaryResult.secure_url,
        thumbnail:      cloudinaryResult.secure_url.includes('/upload/')
            ? cloudinaryResult.secure_url.replace('/upload/', '/upload/w_400,q_auto,f_auto/')
            : cloudinaryResult.secure_url,
        public_id:     cloudinaryResult.public_id,
        resource_type: cloudinaryResult.resource_type,
        format:        cloudinaryResult.format,
        bytes:         cloudinaryResult.bytes,
        google_photos: googlePhotosResult,
        uid:           tokenPayload.uid,
    };

    return corsResponse(JSON.stringify(result), 200, env, 'application/json');
}

/* ─── Cloudinary Upload ────────────────────────────────────────── */
async function uploadToCloudinary(fileBytes, contentType, fileName, folder, env) {
    const cloudName    = env.CLOUDINARY_CLOUD_NAME;
    const uploadPreset = env.CLOUDINARY_UPLOAD_PRESET;
    const apiKey       = env.CLOUDINARY_API_KEY;
    const apiSecret    = env.CLOUDINARY_API_SECRET;

    if (!cloudName || !uploadPreset) {
        throw new Error('Missing Cloudinary env vars: CLOUDINARY_CLOUD_NAME or CLOUDINARY_UPLOAD_PRESET');
    }

    // Detect resource type
    const resourceType = contentType.startsWith('video/') ? 'video' : 'image';

    // Build FormData for Cloudinary
    const fd = new FormData();
    const blob = new Blob([fileBytes], { type: contentType });
    fd.append('file', blob, fileName);
    fd.append('upload_preset', uploadPreset);
    if (folder) fd.append('folder', folder);

    // If using signed uploads (recommended for production):
    // Generate signature using apiKey + apiSecret
    if (apiKey && apiSecret) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const paramsToSign = folder
            ? `folder=${folder}&timestamp=${timestamp}&upload_preset=${uploadPreset}`
            : `timestamp=${timestamp}&upload_preset=${uploadPreset}`;
        const signature = await sha256Hex(paramsToSign + apiSecret);
        fd.append('api_key',   apiKey);
        fd.append('timestamp', timestamp);
        fd.append('signature', signature);
    }

    const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`;
    const res = await fetch(uploadUrl, { method: 'POST', body: fd });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Cloudinary ${res.status}: ${errText}`);
    }

    return res.json();
}

/* ─── Google Photos Sync ─────────────────────────────────────── */
async function syncToGooglePhotos(fileBytes, contentType, fileName, env) {
    // Step A: Get fresh access token using refresh token (OAuth2)
    const accessToken = await getGooglePhotosAccessToken(env);

    // Step B: Upload raw bytes to Google Photos (upload token)
    const uploadRes = await fetch('https://photoslibrary.googleapis.com/v1/uploads', {
        method:  'POST',
        headers: {
            'Authorization':          `Bearer ${accessToken}`,
            'Content-Type':           'application/octet-stream',
            'X-Goog-Upload-Content-Type': contentType,
            'X-Goog-Upload-Protocol': 'raw',
        },
        body: fileBytes
    });

    if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`Photos upload token error ${uploadRes.status}: ${errText}`);
    }

    const uploadToken = await uploadRes.text();

    // Step C: Create media item from upload token
    const createRes = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
        method:  'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify({
            newMediaItems: [{
                description:    'Uploaded via CSM Drive',
                simpleMediaItem: {
                    fileName:    fileName,
                    uploadToken: uploadToken.trim(),
                }
            }]
        })
    });

    if (!createRes.ok) {
        const errText = await createRes.text();
        throw new Error(`Photos create error ${createRes.status}: ${errText}`);
    }

    const createData = await createRes.json();
    const item = createData?.newMediaItemResults?.[0];

    if (item?.status?.code && item.status.code !== 0) {
        throw new Error(`Photos item error: ${item.status.message}`);
    }

    return {
        media_item_id: item?.mediaItem?.id   || null,
        product_url:   item?.mediaItem?.productUrl || null,
        base_url:      item?.mediaItem?.baseUrl    || null,
    };
}

/* ─── Google Photos OAuth2 Token (refresh token flow) ─────────── */
async function getGooglePhotosAccessToken(env) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id:     env.GOOGLE_PHOTOS_CLIENT_ID,
            client_secret: env.GOOGLE_PHOTOS_CLIENT_SECRET,
            refresh_token: env.GOOGLE_PHOTOS_REFRESH_TOKEN,
            grant_type:    'refresh_token',
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OAuth2 token error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (!data.access_token) throw new Error('No access_token in OAuth2 response');
    return data.access_token;
}

/* ═══════════════════════════════════════════════════════════════
   ROUTE: /drive/:fileId  (existing Google Drive proxy)
   ═══════════════════════════════════════════════════════════════ */
async function handleDriveProxy(request, url, path, env) {
    const parts   = path.replace('/drive/', '').split('/');
    const fileId  = parts[0];
    const isThumb = parts[1] === 'thumb';

    if (!fileId) return corsResponse('Missing file ID', 400, env);

    // Verify token (from query param — existing behavior)
    const token = url.searchParams.get('token');
    if (!token) return corsResponse('Unauthorized: no token', 401, env);

    const isValid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
    if (!isValid) return corsResponse('Unauthorized: invalid token', 401, env);

    // Get Google Service Account token
    let gToken;
    try {
        gToken = await getGoogleServiceAccountToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_PRIVATE_KEY);
    } catch (e) {
        return corsResponse('Server error: ' + e.message, 500, env);
    }

    // Thumbnail redirect
    if (isThumb) {
        const metaRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink`,
            { headers: { Authorization: `Bearer ${gToken}` } }
        );
        if (!metaRes.ok) return corsResponse('Drive error', 502, env);
        const meta  = await metaRes.json();
        const thumb = meta.thumbnailLink || '';
        if (!thumb) return corsResponse('No thumbnail', 404, env);
        return Response.redirect(thumb.replace('=s220', '=s400'), 302);
    }

    // Stream the Drive file
    const dl       = url.searchParams.get('dl') === '1';
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const driveRes = await fetch(driveUrl, {
        headers: { Authorization: `Bearer ${gToken}` }
    });

    if (!driveRes.ok) {
        return corsResponse(`Drive error: ${driveRes.status}`, 502, env);
    }

    const contentType = driveRes.headers.get('Content-Type') || 'application/octet-stream';
    const headers = {
        'Content-Type':               contentType,
        'Cache-Control':              'private, max-age=3600',
        'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    };
    if (dl) {
        const filename = url.searchParams.get('name') || fileId;
        headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }

    return new Response(driveRes.body, { status: 200, headers });
}

/* ═══════════════════════════════════════════════════════════════
   FIREBASE TOKEN VERIFICATION
   Uses Web Crypto API — no Firebase Admin SDK needed
   ═══════════════════════════════════════════════════════════════ */
async function verifyFirebaseToken(idToken, projectId) {
    try {
        // Fetch Firebase public keys (Google's JWKS endpoint)
        const keysRes = await fetch(
            'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
        );
        if (!keysRes.ok) throw new Error('Could not fetch Firebase public keys');
        const keys = await keysRes.json();

        // Decode JWT header → get key ID (kid)
        const parts     = idToken.split('.');
        if (parts.length !== 3) return null;
        const [headerB64, payloadB64, sigB64] = parts;

        const header = JSON.parse(b64Decode(headerB64));
        const kid    = header.kid;
        if (!keys[kid]) return null;

        // Import the matching X.509 public certificate
        const certPem = keys[kid];
        const certDer = pemToDer(certPem);
        const pubKey  = await crypto.subtle.importKey(
            'spki', certDer,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false, ['verify']
        );

        // Verify JWT signature
        const sigBuf  = b64UrlToBuf(sigB64);
        const dataBuf = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
        const valid   = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pubKey, sigBuf, dataBuf);
        if (!valid) return null;

        // Validate JWT claims
        const payload = JSON.parse(b64Decode(payloadB64));
        const now     = Math.floor(Date.now() / 1000);
        if (payload.exp < now)        return null; // expired
        if (payload.iat > now + 300)  return null; // issued in future
        if (payload.aud !== projectId) return null; // wrong project
        if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;

        // Return payload (contains uid, email, etc.)
        return payload;
    } catch (e) {
        console.error('[verifyFirebaseToken]', e);
        return null;
    }
}

/* ═══════════════════════════════════════════════════════════════
   GOOGLE SERVICE ACCOUNT → ACCESS TOKEN (for Drive proxy)
   ═══════════════════════════════════════════════════════════════ */
async function getGoogleServiceAccountToken(email, privateKeyPem) {
    const now   = Math.floor(Date.now() / 1000);
    const scope = 'https://www.googleapis.com/auth/drive.readonly';

    const header  = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iss: email, scope,
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
    };

    const b64H = toB64Url(btoa(JSON.stringify(header)));
    const b64P = toB64Url(btoa(JSON.stringify(payload)));
    const signingInput = `${b64H}.${b64P}`;

    const privKeyDer = pemToDer(privateKeyPem);
    const privKey    = await crypto.subtle.importKey(
        'pkcs8', privKeyDer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['sign']
    );

    const sig    = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privKey, new TextEncoder().encode(signingInput));
    const b64Sig = bufToB64Url(sig);
    const jwt    = `${signingInput}.${b64Sig}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:   `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });

    if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`Service account token exchange failed: ${err}`);
    }

    const data = await tokenRes.json();
    return data.access_token;
}

/* ─── CORS Helper ─────────────────────────────────────────────── */
function corsResponse(body, status, env, contentType = 'text/plain') {
    return new Response(body, {
        status,
        headers: {
            'Access-Control-Allow-Origin':  env?.ALLOWED_ORIGIN || '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Content-Type': contentType,
        }
    });
}

/* ─── Crypto Helpers ──────────────────────────────────────────── */
function pemToDer(pem) {
    const b64 = pem
        .replace(/-----BEGIN[^-]+-----/g, '')
        .replace(/-----END[^-]+-----/g, '')
        .replace(/\s+/g, '');
    return b64ToBuf(b64);
}

function b64ToBuf(b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
}

function b64UrlToBuf(b64url) {
    return b64ToBuf(
        b64url.replace(/-/g, '+').replace(/_/g, '/')
              .padEnd(b64url.length + (4 - b64url.length % 4) % 4, '=')
    );
}

function bufToB64Url(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64Decode(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - b64.length % 4) % 4;
    return atob(b64 + '='.repeat(pad));
}

function toB64Url(b64) {
    return b64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function sha256Hex(str) {
    const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
