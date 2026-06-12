/**
 * CSM DRIVE | ULTRA PRO — Cloudflare Worker
 * worker.js
 *
 * Routes:
 *   GET /drive/:fileId               — Stream private Drive file (token required)
 *   GET /drive/:fileId/thumb         — Serve thumbnail URL redirect (token required)
 *   GET /drive/:fileId?dl=1          — Force-download header
 *
 * Environment Variables (set in Cloudflare dashboard → Workers → Settings → Variables):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL     — service account email
 *   GOOGLE_PRIVATE_KEY               — service account private key (PEM, \\n escaped)
 *   FIREBASE_PROJECT_ID              — your Firebase project ID (e.g. photos-58c8e)
 *   ALLOWED_ORIGIN                   — your GitHub Pages URL (e.g. https://csm-storage.github.io)
 */

/* ─── Entry ───────────────────────────────────────────────────── */
export default {
    async fetch(request, env) {
        // CORS preflight
        if (request.method === 'OPTIONS') {
            return corsResponse('', 204, env);
        }

        const url = new URL(request.url);
        const path = url.pathname; // e.g. /drive/1aBcXxx or /drive/1aBcXxx/thumb

        // ─── Google Photos proxy route ───────────────────────────
        if (path.startsWith('/photos/')) {
            return handlePhotosProxy(request, url, path, env);
        }

        if (!path.startsWith('/drive/')) {
            return corsResponse('Not found', 404, env);
        }

        // Parse /drive/:fileId[/thumb]
        const parts  = path.replace('/drive/', '').split('/');
        const fileId = parts[0];
        const isThumb = parts[1] === 'thumb';

        if (!fileId) return corsResponse('Missing file ID', 400, env);

        // ─── Verify Firebase ID token ───────────────────────────
        const token = url.searchParams.get('token');
        if (!token) return corsResponse('Unauthorized: no token', 401, env);

        const isValid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
        if (!isValid) return corsResponse('Unauthorized: invalid token', 401, env);

        // ─── Get Google API access token ────────────────────────
        let gToken;
        try {
            gToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        } catch (e) {
            return corsResponse('Server error: ' + e.message, 500, env);
        }

        // ─── Handle thumbnail redirect ──────────────────────────
        if (isThumb) {
            const metaRes = await fetch(
                `https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink`,
                { headers: { Authorization: `Bearer ${gToken}` } }
            );
            if (!metaRes.ok) return corsResponse('Drive error', 502, env);
            const meta = await metaRes.json();
            const thumb = meta.thumbnailLink || '';
            if (!thumb) return corsResponse('No thumbnail', 404, env);
            return Response.redirect(thumb.replace('=s220', '=s400'), 302);
        }

        // ─── Stream the Drive file ──────────────────────────────
        const dl = url.searchParams.get('dl') === '1';
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

        const driveRes = await fetch(driveUrl, {
            headers: { Authorization: `Bearer ${gToken}` }
        });

        if (!driveRes.ok) {
            return corsResponse(`Drive error: ${driveRes.status}`, 502, env);
        }

        const contentType = driveRes.headers.get('Content-Type') || 'application/octet-stream';
        const headers = {
            'Content-Type':  contentType,
            'Cache-Control': 'private, max-age=3600',
            'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
        };
        if (dl) {
            const filename = url.searchParams.get('name') || fileId;
            headers['Content-Disposition'] = `attachment; filename="${filename}"`;
        }

        return new Response(driveRes.body, { status: 200, headers });
    },

    /* ─── CRON: Auto-sync Google Photos + Cloudinary → Firestore ── */
    async scheduled(event, env, ctx) {
        try {
            await syncGooglePhotos(env);
        } catch (e) {
            console.error('[Cron] Google Photos sync failed:', e.message);
        }
        try {
            await syncCloudinary(env);
        } catch (e) {
            console.error('[Cron] Cloudinary sync failed:', e.message);
        }
    }
};

/* ─── CORS helper ─────────────────────────────────────────────── */
function corsResponse(body, status, env) {
    return new Response(body, {
        status,
        headers: {
            'Access-Control-Allow-Origin':  env?.ALLOWED_ORIGIN || '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Content-Type': 'text/plain',
        }
    });
}

/* ─── Firebase token verification ────────────────────────────── */
async function verifyFirebaseToken(idToken, projectId) {
    try {
        // Fetch Firebase public keys
        const keysRes = await fetch(
            'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
        );
        const keys = await keysRes.json();

        // Decode JWT header to get key ID
        const [headerB64] = idToken.split('.');
        const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
        const kid    = header.kid;

        if (!keys[kid]) return false;

        // Import public key
        const certPem = keys[kid];
        const certDer = pemToDer(certPem);
        const pubKey  = await crypto.subtle.importKey(
            'spki', certDer,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false, ['verify']
        );

        // Verify signature
        const [, payloadB64, sigB64] = idToken.split('.');
        const sigBuf  = b64UrlToBuf(sigB64);
        const dataBuf = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
        const valid   = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pubKey, sigBuf, dataBuf);
        if (!valid) return false;

        // Validate claims
        const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
        const now     = Math.floor(Date.now() / 1000);
        if (payload.exp < now)  return false;
        if (payload.iat > now + 300) return false;
        if (payload.aud !== projectId) return false;
        if (payload.iss !== `https://securetoken.google.com/${projectId}`) return false;

        return true;
    } catch (e) {
        console.error('Token verify error:', e);
        return false;
    }
}

/* ─── Google Service Account → access token ──────────────────── */
async function getGoogleAccessToken(email, privateKeyPem, scope = 'https://www.googleapis.com/auth/drive.readonly') {
    const now   = Math.floor(Date.now() / 1000);

    // Build JWT claim set
    const header  = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iss: email,
        scope,
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
    };

    const b64Header  = btoa(JSON.stringify(header))  .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const b64Payload = btoa(JSON.stringify(payload)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const signingInput = `${b64Header}.${b64Payload}`;

    // Import private key
    const privKeyDer = pemToDer(privateKeyPem);
    const privKey    = await crypto.subtle.importKey(
        'pkcs8', privKeyDer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['sign']
    );

    // Sign
    const sig    = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privKey, new TextEncoder().encode(signingInput));
    const b64Sig = bufToB64Url(sig);
    const jwt    = `${signingInput}.${b64Sig}`;

    // Exchange for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:   `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });

    if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`Token exchange failed: ${err}`);
    }

    const data = await tokenRes.json();
    return data.access_token;
}

/* ─── Crypto helpers ─────────────────────────────────────────── */
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
    return b64ToBuf(b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(
        b64url.length + (4 - b64url.length % 4) % 4, '='
    ));
}

function bufToB64Url(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/* ════════════════════════════════════════════════════════════════
   GOOGLE PHOTOS — OAuth (refresh token) → access token
   ════════════════════════════════════════════════════════════════ */
async function getPhotosAccessToken(env) {
    const params = new URLSearchParams({
        client_id:     env.GOOGLE_PHOTOS_CLIENT_ID,
        client_secret: env.GOOGLE_PHOTOS_CLIENT_SECRET,
        refresh_token: env.GOOGLE_PHOTOS_REFRESH_TOKEN,
        grant_type:    'refresh_token'
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Photos token refresh failed: ${err}`);
    }
    const data = await res.json();
    return data.access_token;
}

/* ─── /photos/:mediaItemId proxy route ───────────────────────────
   Fetches a fresh baseUrl from the Photos Library API (since baseUrl
   expires after ~60 min) and streams the image/video bytes through.
   Usage: /photos/MEDIA_ITEM_ID?token=FIREBASE_ID_TOKEN[&thumb=1][&dl=1]
   ─────────────────────────────────────────────────────────────── */
async function handlePhotosProxy(request, url, path, env) {
    if (request.method === 'OPTIONS') return corsResponse('', 204, env);

    const mediaItemId = path.replace('/photos/', '').split('/')[0];
    if (!mediaItemId) return corsResponse('Missing media item ID', 400, env);

    const token = url.searchParams.get('token');
    if (!token) return corsResponse('Unauthorized: no token', 401, env);

    const isValid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
    if (!isValid) return corsResponse('Unauthorized: invalid token', 401, env);

    let pToken;
    try {
        pToken = await getPhotosAccessToken(env);
    } catch (e) {
        return corsResponse('Server error: ' + e.message, 500, env);
    }

    // Fetch fresh media item metadata (baseUrl is short-lived)
    const metaRes = await fetch(
        `https://photoslibrary.googleapis.com/v1/mediaItems/${mediaItemId}`,
        { headers: { Authorization: `Bearer ${pToken}` } }
    );
    if (!metaRes.ok) return corsResponse('Photos API error: ' + metaRes.status, 502, env);
    const meta = await metaRes.json();

    const isVideo  = meta.mediaMetadata?.video !== undefined;
    const thumb    = url.searchParams.get('thumb') === '1';
    const dl       = url.searchParams.get('dl') === '1';
    let mediaUrl;

    if (isVideo) {
        // =dv  -> downloadable video, =dvm  -> playable preview
        mediaUrl = `${meta.baseUrl}=dv`;
    } else {
        mediaUrl = thumb ? `${meta.baseUrl}=w400-h400` : `${meta.baseUrl}=d`;
    }

    const mediaRes = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${pToken}` } });
    if (!mediaRes.ok) return corsResponse('Media fetch error: ' + mediaRes.status, 502, env);

    const contentType = mediaRes.headers.get('Content-Type') || (isVideo ? 'video/mp4' : 'image/jpeg');
    const headers = {
        'Content-Type':  contentType,
        'Cache-Control': 'private, max-age=3600',
        'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    };
    if (dl) {
        const filename = url.searchParams.get('name') || mediaItemId;
        headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }

    return new Response(mediaRes.body, { status: 200, headers });
}

/* ════════════════════════════════════════════════════════════════
   FIRESTORE REST HELPERS (using existing service-account JWT)
   ════════════════════════════════════════════════════════════════ */
async function getFirestoreAccessToken(env) {
    return getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_PRIVATE_KEY, 'https://www.googleapis.com/auth/datastore');
}

const FS_BASE = (projectId) =>
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

/* Convert a plain JS object into Firestore REST "fields" format */
function toFirestoreFields(obj) {
    const fields = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined) {
            fields[k] = { nullValue: null };
        } else if (typeof v === 'boolean') {
            fields[k] = { booleanValue: v };
        } else if (typeof v === 'number') {
            fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
        } else if (v instanceof Date) {
            fields[k] = { timestampValue: v.toISOString() };
        } else if (typeof v === 'object') {
            fields[k] = { mapValue: { fields: toFirestoreFields(v) } };
        } else {
            fields[k] = { stringValue: String(v) };
        }
    }
    return fields;
}

/* Convert Firestore REST "fields" format back into a plain JS object */
function fromFirestoreFields(fields = {}) {
    const obj = {};
    for (const [k, v] of Object.entries(fields)) {
        if ('stringValue'  in v) obj[k] = v.stringValue;
        else if ('integerValue' in v) obj[k] = parseInt(v.integerValue, 10);
        else if ('doubleValue'  in v) obj[k] = v.doubleValue;
        else if ('booleanValue' in v) obj[k] = v.booleanValue;
        else if ('timestampValue' in v) obj[k] = v.timestampValue;
        else if ('mapValue' in v) obj[k] = fromFirestoreFields(v.mapValue.fields || {});
        else if ('nullValue' in v) obj[k] = null;
    }
    return obj;
}

/* Create a document with a specific ID (won't overwrite existing fields not provided) */
async function firestoreSetDoc(env, fsToken, collectionPath, docId, data) {
    const url = `${FS_BASE(env.FIREBASE_PROJECT_ID)}/${collectionPath}/${docId}`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${fsToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields: toFirestoreFields(data) })
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Firestore setDoc failed (${docId}): ${err}`);
    }
    return res.json();
}

/* Get a single document; returns null if not found */
async function firestoreGetDoc(env, fsToken, collectionPath, docId) {
    const url = `${FS_BASE(env.FIREBASE_PROJECT_ID)}/${collectionPath}/${docId}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${fsToken}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore getDoc failed: ${await res.text()}`);
    const data = await res.json();
    return fromFirestoreFields(data.fields || {});
}

/* Check if a document already exists (cheap existence check) */
async function firestoreDocExists(env, fsToken, collectionPath, docId) {
    const doc = await firestoreGetDoc(env, fsToken, collectionPath, docId);
    return doc !== null;
}

/* ════════════════════════════════════════════════════════════════
   GOOGLE PHOTOS SYNC
   - Scans entire library (mediaItems:search with no album filter)
   - Uses settings/sync_state.photos_page_token to resume
   - On reaching items already in Firestore (or end of pages),
     resets the cursor back to start for next run (covers new
     uploads which appear at the front of the library list)
   ════════════════════════════════════════════════════════════════ */
async function syncGooglePhotos(env) {
    const fsToken    = await getFirestoreAccessToken(env);
    const photosToken = await getPhotosAccessToken(env);

    const SETTINGS_COL = 'settings';
    const FILES_COL    = 'files';
    const STATE_DOC    = 'sync_state';

    const state = await firestoreGetDoc(env, fsToken, SETTINGS_COL, STATE_DOC) || {};
    let pageToken = state.photos_page_token || '';

    const MAX_PAGES = 3; // ~3 * 100 items per cron run, newest first
    let newCount = 0;
    let stop = false;

    for (let page = 0; page < MAX_PAGES && !stop; page++) {
        const body = { pageSize: 100 };
        if (pageToken) body.pageToken = pageToken;

        const res = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:search', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${photosToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            console.error('[Photos] search failed:', await res.text());
            break;
        }

        const data = await res.json();
        const items = data.mediaItems || [];

        for (const item of items) {
            const docId = `photos_${item.id}`;
            const exists = await firestoreDocExists(env, fsToken, FILES_COL, docId);
            if (exists) {
                // Reached items we've already synced — stop entirely.
                stop = true;
                break;
            }

            const isVideo = item.mediaMetadata?.video !== undefined;
            const createdTime = item.mediaMetadata?.creationTime
                ? new Date(item.mediaMetadata.creationTime).getTime()
                : Date.now();

            await firestoreSetDoc(env, fsToken, FILES_COL, docId, {
                id:         docId,
                name:       item.filename || docId,
                cat:        isVideo ? 'video' : 'image',
                size:       0,
                folder:     'all',
                time:       createdTime,
                starred:    false,
                locked:     false,
                trash:      false,
                source:     'gphotos',
                photos_id:  item.id,
                thumbnail:  `${item.baseUrl}=w400-h400`,
                uploadedAt: new Date()
            });
            newCount++;
        }

        if (!data.nextPageToken || stop) {
            // Reached the end of the library (or already-synced items) —
            // reset cursor so future runs check from the newest items.
            pageToken = '';
            break;
        }
        pageToken = data.nextPageToken;
    }

    await firestoreSetDoc(env, fsToken, SETTINGS_COL, STATE_DOC, {
        photos_page_token: pageToken,
        photos_last_sync:  new Date()
    });

    console.log(`[Photos] synced ${newCount} new item(s)`);
}

/* ════════════════════════════════════════════════════════════════
   CLOUDINARY SYNC
   - Lists all resources (image + video) via Admin API
   - Uses settings/sync_state.cloudinary_image_cursor / _video_cursor
     to resume listing
   - Resets cursor on reaching already-synced items (new uploads
     appear first since Cloudinary lists newest-first by default
     when sorted by created_at desc — using max_results + next_cursor)
   ════════════════════════════════════════════════════════════════ */
async function syncCloudinary(env) {
    const fsToken = await getFirestoreAccessToken(env);
    const auth = btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`);

    const SETTINGS_COL = 'settings';
    const FILES_COL    = 'files';
    const STATE_DOC    = 'sync_state';

    const state = await firestoreGetDoc(env, fsToken, SETTINGS_COL, STATE_DOC) || {};

    for (const resourceType of ['image', 'video']) {
        const cursorKey = `cloudinary_${resourceType}_cursor`;
        let cursor = state[cursorKey] || '';
        let newCount = 0;
        let stop = false;

        const MAX_PAGES = 3;
        for (let page = 0; page < MAX_PAGES && !stop; page++) {
            const params = new URLSearchParams({
                type: 'upload',
                max_results: '100',
                direction: 'desc'
            });
            if (cursor) params.set('next_cursor', cursor);

            const res = await fetch(
                `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/resources/${resourceType}?${params.toString()}`,
                { headers: { Authorization: `Basic ${auth}` } }
            );

            if (!res.ok) {
                console.error(`[Cloudinary:${resourceType}] list failed:`, await res.text());
                break;
            }

            const data = await res.json();
            const items = data.resources || [];

            for (const item of items) {
                const docId = `cld_${item.asset_id}`;
                const exists = await firestoreDocExists(env, fsToken, FILES_COL, docId);
                if (exists) {
                    stop = true;
                    break;
                }

                const thumb = resourceType === 'image'
                    ? item.secure_url.replace('/upload/', '/upload/w_400,q_auto,f_auto/')
                    : item.secure_url.replace('/upload/', '/upload/so_0,w_400,q_auto,f_jpg/').replace(/\.\w+$/, '.jpg');

                await firestoreSetDoc(env, fsToken, FILES_COL, docId, {
                    id:             docId,
                    name:           item.filename || item.public_id,
                    cat:            resourceType === 'video' ? 'video' : 'image',
                    size:           item.bytes || 0,
                    folder:         'all',
                    time:           new Date(item.created_at).getTime(),
                    starred:        false,
                    locked:         false,
                    trash:          false,
                    source:         'cloudinary',
                    cloudinary_url: item.secure_url,
                    thumbnail:      thumb,
                    uploadedAt:     new Date()
                });
                newCount++;
            }

            if (!data.next_cursor || stop) {
                cursor = '';
                break;
            }
            cursor = data.next_cursor;
        }

        state[cursorKey] = cursor;
        console.log(`[Cloudinary:${resourceType}] synced ${newCount} new item(s)`);
    }

    state.cloudinary_last_sync = new Date();
    await firestoreSetDoc(env, fsToken, SETTINGS_COL, STATE_DOC, state);
}
