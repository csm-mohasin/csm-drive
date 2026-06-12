/**
 * CSM DRIVE | ULTRA PRO — Cloudflare Worker
 * Fully Automatic Sync with Google Photos + Cloudinary
 * No manual Drive registration needed
 */

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return corsResponse('', 204, env);
        }

        const url = new URL(request.url);
        const path = url.pathname;

        // ─── Google Photos Proxy ───────────────────────────────
        if (path.startsWith('/photos/')) {
            return handlePhotosProxy(request, url, path, env);
        }

        // ─── Google Drive Proxy (for backward compatibility) ───
        if (path.startsWith('/drive/')) {
            return handleDriveProxy(request, url, path, env);
        }

        return corsResponse('Not found', 404, env);
    },

    // Cron Job — প্রতি ৫ মিনিটে সিঙ্ক হবে
    async scheduled(event, env) {
        console.log(`[Cron] Starting sync at ${new Date().toISOString()}`);
        
        try {
            await syncGooglePhotos(env);
        } catch (e) {
            console.error('[Cron] Google Photos sync failed:', e);
        }

        try {
            await syncCloudinary(env);
        } catch (e) {
            console.error('[Cron] Cloudinary sync failed:', e);
        }
    }
};

/* ==================== CORS ==================== */
function corsResponse(body, status, env) {
    return new Response(body, {
        status,
        headers: {
            'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Content-Type': 'text/plain',
        }
    });
}

/* ==================== DRIVE PROXY ==================== */
async function handleDriveProxy(request, url, path, env) {
    const parts = path.replace('/drive/', '').split('/');
    const fileId = parts[0];
    const isThumb = parts[1] === 'thumb';

    const token = url.searchParams.get('token');
    if (!token) return corsResponse('Unauthorized: no token', 401, env);

    const isValid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
    if (!isValid) return corsResponse('Unauthorized: invalid token', 401, env);

    let gToken;
    try {
        gToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_PRIVATE_KEY);
    } catch (e) {
        return corsResponse('Server error: ' + e.message, 500, env);
    }

    if (isThumb) {
        const metaRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink`,
            { headers: { Authorization: `Bearer ${gToken}` } }
        );
        if (!metaRes.ok) return corsResponse('No thumbnail', 404, env);
        const meta = await metaRes.json();
        const thumb = meta.thumbnailLink?.replace('=s220', '=s600') || '';
        return thumb ? Response.redirect(thumb, 302) : corsResponse('No thumbnail', 404, env);
    }

    const dl = url.searchParams.get('dl') === '1';
    const driveRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${gToken}` }
    });

    if (!driveRes.ok) return corsResponse('Drive error', 502, env);

    const headers = {
        'Content-Type': driveRes.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
        'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    };

    if (dl) {
        const filename = url.searchParams.get('name') || fileId;
        headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }

    return new Response(driveRes.body, { status: 200, headers });
}

/* ==================== TOKEN HELPERS ==================== */
async function verifyFirebaseToken(idToken, projectId) {
    // তোমার আগের verifyFirebaseToken ফাংশন রাখো (পুরোটা)
    // ... (আগের কোড থেকে কপি করে নাও)
}

async function getGoogleAccessToken(email, privateKeyPem) {
    // তোমার আগের getGoogleAccessToken ফাংশন রাখো
    // ... (আগের কোড থেকে কপি করে নাও)
}

/* ==================== PHOTOS PROXY ==================== */
async function handlePhotosProxy(request, url, path, env) {
    // তোমার আগের handlePhotosProxy ফাংশন রাখো
    // ... (আগের কোড থেকে কপি করে নাও)
}

async function getPhotosAccessToken(env) {
    // তোমার আগের ফাংশন রাখো
}

/* ==================== FIRESTORE HELPERS ==================== */
async function getFirestoreAccessToken(env) {
    return getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_PRIVATE_KEY, 'https://www.googleapis.com/auth/datastore');
}

// toFirestoreFields, fromFirestoreFields, firestoreSetDoc, firestoreGetDoc ইত্যাদি — তোমার আগের কোড রাখো

/* ==================== AUTO SYNC ==================== */
async function syncGooglePhotos(env) {
    const fsToken = await getFirestoreAccessToken(env);
    const photosToken = await getPhotosAccessToken(env);

    const SETTINGS_COL = 'settings';
    const FILES_COL = 'files';
    const STATE_DOC = 'sync_state';

    const state = await firestoreGetDoc(env, fsToken, SETTINGS_COL, STATE_DOC) || {};
    let pageToken = state.photos_page_token || '';

    let newCount = 0;
    let stop = false;
    const MAX_PAGES = 5;

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

        if (!res.ok) break;

        const data = await res.json();
        const items = data.mediaItems || [];

        for (const item of items) {
            const docId = `photos_${item.id}`;
            if (await firestoreDocExists(env, fsToken, FILES_COL, docId)) {
                stop = true;
                break;
            }

            const isVideo = !!item.mediaMetadata?.video;
            const createdTime = item.mediaMetadata?.creationTime 
                ? new Date(item.mediaMetadata.creationTime).getTime() 
                : Date.now();

            await firestoreSetDoc(env, fsToken, FILES_COL, docId, {
                id: docId,
                name: item.filename || docId,
                cat: isVideo ? 'video' : 'image',
                size: 0,
                folder: 'all',
                time: createdTime,
                starred: false,
                locked: false,
                trash: false,
                source: 'gphotos',
                photos_id: item.id,
                thumbnail: `${item.baseUrl}=w600-h600`,
                uploadedAt: new Date()
            });
            newCount++;
        }

        pageToken = data.nextPageToken || '';
        if (!pageToken || stop) break;
    }

    await firestoreSetDoc(env, fsToken, SETTINGS_COL, STATE_DOC, {
        photos_page_token: pageToken,
        photos_last_sync: new Date()
    });

    console.log(`[Photos] Synced ${newCount} new items`);
}

async function syncCloudinary(env) {
    // তোমার আগের syncCloudinary ফাংশন রাখো (এটা ঠিক আছে)
    // ... পুরো ফাংশন কপি করে নাও
}

/* ==================== CRYPTO HELPERS ==================== */
// pemToDer, b64ToBuf ইত্যাদি — তোমার আগের কোড রাখো
