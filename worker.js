/* ==========================================================================
   ⚡ CSM DRIVE ULTRA PRO: FINAL REALTIME SYNC ENGINE
   ========================================================================== */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url);

  // রিয়েল-টাইম সিঙ্ক রাউট
  if (url.pathname === '/api/media-sync' && request.method === 'GET') {
    return await handleMediaSync();
  }

  // স্ট্রিম রাউট (ইমেজ/ভিডিও প্রিভিউয়ের জন্য)
  if (url.pathname === '/api/stream') {
    return new Response("Streaming active", { status: 200 });
  }

  return new Response("CSM Drive Worker Online", { status: 200 });
}

async function handleMediaSync() {
  try {
    // গুগল ফটোজ থেকে ডেটা ফেচ (ভ্যারিয়েবল থেকে কী রিড হবে)
    const gpResponse = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems', {
      headers: { 'Authorization': `Bearer ${GOOGLE_ACCESS_TOKEN}` }
    });
    const gpData = await gpResponse.json();

    // ক্লাউডিনারি থেকে ডেটা ফেচ
    const clResponse = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/image`, {
      headers: { 'Authorization': `Basic ${CLOUDINARY_API_KEY}` }
    });
    const clData = await clResponse.json();

    // ডেটা মার্জ করা
    const combinedData = {
      files: [
        ...(gpData.mediaItems || []).map(item => ({
          id: item.id,
          name: item.filename,
          size: item.mediaMetadata.photo ? 0 : 0, 
          mimeType: item.mimeType,
          thumbnailUrl: item.baseUrl,
          createdAt: item.mediaMetadata.creationTime
        })),
        ...(clData.resources || []).map(item => ({
          id: item.public_id,
          name: item.filename + '.' + item.format,
          size: item.bytes,
          mimeType: item.resource_type + '/' + item.format,
          thumbnailUrl: item.secure_url,
          createdAt: item.created_at
        }))
      ],
      folders: []
    };

    return new Response(JSON.stringify(combinedData), {
      headers: { 
        'Content-Type': 'application/json', 
        'Access-Control-Allow-Origin': 'https://csm-storage.github.io' 
      }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: "Sync failed", details: error.message }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
