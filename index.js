const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Firebase Admin ────────────────────────────────────────────────────────────

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ── Spotify Client Credentials Token ─────────────────────────────────────────

let access_token = '';

async function refreshToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID || process.env.CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || process.env.CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('❌ Missing Spotify credentials');
    return;
  }
  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'client_credentials' }),
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    access_token = response.data.access_token;
    console.log('✅ Spotify client token refreshed');
  } catch (error) {
    console.error('❌ Failed to refresh token:', error.response?.data || error.message);
  }
}

refreshToken();
setInterval(refreshToken, 50 * 60 * 1000);

// ── Keep-alive ────────────────────────────────────────────────────────────────

setInterval(() => {
  https.get('https://resonance-proxy.onrender.com', (res) => {
    console.log('🏓 Keep-alive ping:', res.statusCode);
  }).on('error', (err) => {
    console.log('🏓 Keep-alive error:', err.message);
  });
}, 14 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function isHtmlResponse(data) {
  return typeof data === 'string' && data.includes('<html');
}

async function getUserTokens(uid) {
  const userDoc = await db.collection('users').doc(uid).get();
  const tokens = userDoc.data()?.spotifyTokens;
  if (!tokens) throw new Error('No Spotify tokens for user');
  return tokens;
}

async function getValidUserToken(uid) {
  const tokens = await getUserTokens(uid);
  const now = Date.now();
  const expiresAt = tokens.expiresAt?.toMillis
    ? tokens.expiresAt.toMillis()
    : tokens.expiresAt;

  if (now < expiresAt - 60000) {
    return tokens.accessToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID || process.env.CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || process.env.CLIENT_SECRET;

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken
    }),
    {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  const newAccessToken = response.data.access_token;
  const newExpiresAt = admin.firestore.Timestamp.fromMillis(now + response.data.expires_in * 1000);

  await db.collection('users').doc(uid).update({
    'spotifyTokens.accessToken': newAccessToken,
    'spotifyTokens.expiresAt': newExpiresAt
  });

  console.log(`✅ Refreshed user token for ${uid}`);
  return newAccessToken;
}

// ── Notification Helper ───────────────────────────────────────────────────────

const apns = {
  payload: {
    aps: {
      sound: 'default',
      badge: 1
    }
  }
};

async function sendPushNotification(recipientUid, type, payload) {
  try {
    const userDoc = await db.collection('users').doc(recipientUid).get();
    const fcmToken = userDoc.data()?.fcmToken;
    if (!fcmToken) {
      console.log(`⚠️ No FCM token for ${recipientUid}`);
      return { sent: false, reason: 'No FCM token' };
    }

    const message = buildMessage(type, payload, fcmToken);
    if (!message) return { sent: false, reason: `Unknown type: ${type}` };

    const result = await admin.messaging().send(message);
    console.log(`✅ Push sent [${type}] to ${recipientUid}: ${result}`);
    return { sent: true };
  } catch (err) {
    console.error(`❌ Push failed [${type}] to ${recipientUid}:`, err.message);
    return { sent: false, reason: err.message };
  }
}

function buildMessage(type, payload, token) {
  const base = { token, apns };

  switch (type) {
    case 'newFollower':
      return {
        ...base,
        notification: {
          title: `${payload.fromName} followed you`,
          body: 'Tap to view their profile.'
        },
        data: { type, fromUid: payload.fromUid ?? '', fromName: payload.fromName ?? '' }
      };

    case 'entryComment':
      return {
        ...base,
        notification: {
          title: `${payload.fromName} left a note`,
          body: payload.albumTitle ? `on your entry for ${payload.albumTitle}` : 'on your entry'
        },
        data: {
          type,
          fromUid:    payload.fromUid    ?? '',
          fromName:   payload.fromName   ?? '',
          entryId:    payload.entryId    ?? ''
        }
      };

    case 'commentReply':
      return {
        ...base,
        notification: {
          title: `${payload.fromName} replied to you`,
          body: payload.albumTitle ? `on ${payload.albumTitle}` : 'on your note'
        },
        data: {
          type,
          fromUid:    payload.fromUid    ?? '',
          fromName:   payload.fromName   ?? '',
          entryId:    payload.entryId    ?? ''
        }
      };

    case 'commentLike':
      return {
        ...base,
        notification: {
          title: `${payload.fromName} liked your note`,
          body: payload.albumTitle ? `on ${payload.albumTitle}` : ''
        },
        data: {
          type,
          fromUid:    payload.fromUid    ?? '',
          fromName:   payload.fromName   ?? '',
          entryId:    payload.entryId    ?? ''
        }
      };

    case 'albumSuggestion':
      return {
        ...base,
        notification: {
          title: `${payload.fromName} suggested an album`,
          body: payload.albumTitle
            ? `"${payload.albumTitle}" — check it out on their profile`
            : 'Tap to see what they think you should hear.'
        },
        data: {
          type,
          fromUid:  payload.fromUid  ?? '',
          fromName: payload.fromName ?? ''
        }
      };

    case 'suggestionAgree':
      return {
        ...base,
        notification: {
          title: `${payload.fromName} agrees`,
          body: payload.albumTitle
            ? `You should really listen to ${payload.albumTitle}`
            : 'Someone else thinks you should hear this too.'
        },
        data: {
          type,
          fromUid:  payload.fromUid  ?? '',
          fromName: payload.fromName ?? ''
        }
      };

    case 'suggestionReviewed':
      return {
        ...base,
        notification: {
          title: `${payload.authorName} finally listened`,
          body: payload.albumTitle
            ? `${payload.albumTitle}${payload.ratingString ? ` — ${payload.ratingString}` : ''}`
            : 'Tap to see their entry.'
        },
        data: {
          type,
          authorUid:  payload.authorUid  ?? '',
          authorName: payload.authorName ?? '',
          entryId:    payload.entryId    ?? ''
        }
      };

    case 'weeklyPrompt':
      return {
        ...base,
        notification: {
          title: "This week's prompt is here",
          body: payload.promptText ? `"${payload.promptText}"` : 'Open Resonance to see it.'
        },
        data: { type, promptText: payload.promptText ?? '' }
      };

    default:
      return null;
  }
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ── Root ──────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('🎵 Resonance Spotify proxy is live');
});

// ── Debug token ───────────────────────────────────────────────────────────────

app.get('/test-token', async (req, res) => {
  const clientId = process.env.SPOTIFY_CLIENT_ID || process.env.CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || process.env.CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).send('Missing credentials');
  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'client_credentials' }),
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    res.send(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// ── Search ────────────────────────────────────────────────────────────────────

app.get('/search', async (req, res) => {
  const { q, type = 'album' } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing search query' });

  try {
    const result = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${access_token}` },
      params: { q, type }
    });

    if (isHtmlResponse(result.data)) {
      return res.status(503).json({ error: 'Proxy cold start, retry' });
    }

    if (type === 'album') {
      res.json(result.data.albums.items);
    } else if (type === 'artist') {
      res.json(result.data.artists.items);
    } else {
      res.status(400).json({ error: `Unsupported type: ${type}` });
    }
  } catch (error) {
    console.error('🔍 Search failed:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// ── Artist Info ───────────────────────────────────────────────────────────────

app.get('/artist-info', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing artist ID' });
  try {
    const result = await axios.get(`https://api.spotify.com/v1/artists/${id}`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (isHtmlResponse(result.data)) return res.status(503).json({ error: 'Proxy cold start, retry' });
    res.json(result.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Artist Albums ─────────────────────────────────────────────────────────────

app.get('/artist-albums', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing artist ID' });
  try {
    const result = await axios.get(`https://api.spotify.com/v1/artists/${id}/albums`, {
      headers: { Authorization: `Bearer ${access_token}` },
      params: { include_groups: 'album', limit: 50 }
    });
    if (isHtmlResponse(result.data)) return res.status(503).json({ error: 'Proxy cold start, retry' });
    res.json(result.data.items);
  } catch (error) {
    console.error('❌ Artist albums fetch failed:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch albums' });
  }
});

// ── Album Tracks ──────────────────────────────────────────────────────────────

app.get('/album-tracks', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing album ID' });
  try {
    const result = await axios.get(`https://api.spotify.com/v1/albums/${id}/tracks`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (isHtmlResponse(result.data)) return res.status(503).json({ error: 'Proxy cold start, retry' });
    res.json(result.data.items);
  } catch (error) {
    console.error('❌ Album tracks fetch failed:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

// ── Album Details ─────────────────────────────────────────────────────────────

app.get('/album-details', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing album ID' });
  try {
    const result = await axios.get(`https://api.spotify.com/v1/albums/${id}`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (isHtmlResponse(result.data)) return res.status(503).json({ error: 'Proxy cold start, retry' });
    res.json(result.data);
  } catch (error) {
    console.error('❌ Album details fetch failed:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch album details' });
  }
});

// ── Full Album ────────────────────────────────────────────────────────────────

app.get('/full-album', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing album ID' });
  try {
    const result = await axios.get(`https://api.spotify.com/v1/albums/${id}`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (isHtmlResponse(result.data)) return res.status(503).json({ error: 'Proxy cold start, retry' });
    res.json(result.data);
  } catch (error) {
    console.error('❌ Full album fetch failed:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch full album data' });
  }
});

// ── Artists endpoint ──────────────────────────────────────────────────────────

app.get('/artists', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing artist ID' });
  try {
    const result = await axios.get(`https://api.spotify.com/v1/artists/${id}`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (isHtmlResponse(result.data)) return res.status(503).json({ error: 'Proxy cold start, retry' });
    res.json(result.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── OAuth — Get Auth URL ──────────────────────────────────────────────────────

app.get('/spotify/auth/url', (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  const clientId = process.env.SPOTIFY_CLIENT_ID || process.env.CLIENT_ID;
  const redirectUri = 'https://resonance-proxy.onrender.com/spotify/auth/callback';

  const scopes = [
    'user-read-recently-played',
    'user-top-read',
    'user-read-currently-playing',
    'user-read-playback-state'
  ].join(' ');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: scopes,
    redirect_uri: redirectUri,
    state: uid
  });

  res.json({ url: `https://accounts.spotify.com/authorize?${params.toString()}` });
});

// ── OAuth — Callback ──────────────────────────────────────────────────────────

app.get('/spotify/auth/callback', async (req, res) => {
  const { code, state: uid, error } = req.query;

  if (error) {
    console.error('Spotify auth error:', error);
    return res.status(400).send(`Spotify auth error: ${error}`);
  }

  if (!code || !uid) return res.status(400).send('Missing code or uid');

  const clientId = process.env.SPOTIFY_CLIENT_ID || process.env.CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || process.env.CLIENT_SECRET;
  const redirectUri = 'https://resonance-proxy.onrender.com/spotify/auth/callback';

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      }),
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const { access_token: accessToken, refresh_token: refreshToken, expires_in } = response.data;
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + expires_in * 1000);

    await db.collection('users').doc(uid).update({
      spotifyTokens: { accessToken, refreshToken, expiresAt },
      spotifyConnected: true
    });

    console.log(`✅ Spotify connected for user ${uid}`);
    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 60px; background: #080e1a; color: #f7cc3a;">
          <h2>Spotify connected ✓</h2>
          <p style="color: white;">You can close this window and return to Resonance.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Failed to connect Spotify. Please try again.');
  }
});

// ── OAuth — Disconnect ────────────────────────────────────────────────────────

app.post('/spotify/auth/disconnect', async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  try {
    await db.collection('users').doc(uid).update({
      spotifyTokens: admin.firestore.FieldValue.delete(),
      spotifyConnected: false,
      currentlySpinning: admin.firestore.FieldValue.delete()
    });
    console.log(`✅ Spotify disconnected for user ${uid}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Disconnect failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── User — Recently Played ────────────────────────────────────────────────────

app.get('/spotify/recently-played', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  try {
    const token = await getValidUserToken(uid);
    const result = await axios.get('https://api.spotify.com/v1/me/player/recently-played', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 50 }
    });

    if (isHtmlResponse(result.data)) return res.status(503).json({ error: 'Proxy cold start, retry' });

    const seenAlbumIds = new Set();
    const albums = [];

    for (const item of result.data.items) {
      const album = item.track.album;
      if (!seenAlbumIds.has(album.id)) {
        seenAlbumIds.add(album.id);
        albums.push({
          albumId:      album.id,
          albumTitle:   album.name,
          albumArtist:  album.artists[0]?.name ?? '',
          albumCoverURL: album.images[0]?.url ?? '',
          lastPlayedAt: item.played_at
        });
      }
    }

    res.json(albums);
  } catch (err) {
    console.error('❌ Recently played failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── User — Currently Playing ──────────────────────────────────────────────────

app.get('/spotify/currently-playing', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  try {
    const token = await getValidUserToken(uid);
    const result = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!result.data || result.status === 204) {
      await db.collection('users').doc(uid).update({
        currentlySpinning: admin.firestore.FieldValue.delete()
      });
      return res.json({ playing: false });
    }

    if (isHtmlResponse(result.data)) return res.status(503).json({ error: 'Proxy cold start, retry' });

    const track = result.data.item;
    const album = track?.album;
    if (!album) return res.json({ playing: false });

    const currentlySpinning = {
      albumId:      album.id,
      albumTitle:   album.name,
      albumArtist:  album.artists[0]?.name ?? '',
      albumCoverURL: album.images[0]?.url ?? '',
      trackTitle:   track.name,
      updatedAt:    admin.firestore.Timestamp.now()
    };

    await db.collection('users').doc(uid).update({ currentlySpinning });
    res.json({ playing: true, ...currentlySpinning });
  } catch (err) {
    console.error('❌ Currently playing failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── User — Top Artists ────────────────────────────────────────────────────────

app.get('/spotify/top-artists', async (req, res) => {
  const { uid, time_range = 'medium_term' } = req.query;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  try {
    const token = await getValidUserToken(uid);
    const result = await axios.get('https://api.spotify.com/v1/me/top/artists', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 50, time_range }
    });

    if (isHtmlResponse(result.data)) return res.status(503).json({ error: 'Proxy cold start, retry' });
    res.json(result.data.items);
  } catch (err) {
    console.error('❌ Top artists failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── User — Sync Spotify Prompts ───────────────────────────────────────────────

app.post('/spotify/sync-prompts', async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  try {
    const token = await getValidUserToken(uid);
    const result = await axios.get('https://api.spotify.com/v1/me/player/recently-played', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 50 }
    });

    if (isHtmlResponse(result.data)) return res.status(503).json({ error: 'Proxy cold start, retry' });

    const [diarySnap, userDoc] = await Promise.all([
      db.collection('users').doc(uid).collection('diaryEntries').get(),
      db.collection('users').doc(uid).get()
    ]);

    const loggedAlbumIds = new Set(diarySnap.docs.map(d => d.data().albumId));
    const dismissed = new Set(userDoc.data()?.dismissedSpotifyPrompts ?? []);

    const seenAlbumIds = new Set();
    const candidates = [];

    for (const item of result.data.items) {
      const album = item.track.album;
      if (!seenAlbumIds.has(album.id) && !loggedAlbumIds.has(album.id) && !dismissed.has(album.id)) {
        seenAlbumIds.add(album.id);
        candidates.push({
          albumId:      album.id,
          albumTitle:   album.name,
          albumArtist:  album.artists[0]?.name ?? '',
          albumCoverURL: album.images[0]?.url ?? '',
          lastPlayedAt: admin.firestore.Timestamp.fromDate(new Date(item.played_at)),
          createdAt:    admin.firestore.Timestamp.now()
        });
      }
    }

    const limited = candidates.slice(0, 10);
    const batch = db.batch();

    const existingPrompts = await db.collection('users').doc(uid).collection('spotifyPrompts').get();
    existingPrompts.docs.forEach(d => batch.delete(d.ref));

    for (const prompt of limited) {
      const ref = db.collection('users').doc(uid).collection('spotifyPrompts').doc(prompt.albumId);
      batch.set(ref, prompt);
    }

    await batch.commit();
    console.log(`✅ Synced ${limited.length} Spotify prompts for user ${uid}`);
    res.json({ synced: limited.length });
  } catch (err) {
    console.error('❌ Sync prompts failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Push Notifications ────────────────────────────────────────────────────────

app.post('/notify', async (req, res) => {
  const { recipientUid, type, ...payload } = req.body;
  if (!recipientUid || !type) {
    return res.status(400).json({ error: 'Missing recipientUid or type' });
  }
  const result = await sendPushNotification(recipientUid, type, payload);
  res.json(result);
});

// ── Weekly Prompt Push ────────────────────────────────────────────────────────

app.post('/notify/weekly-prompt', async (req, res) => {
  const secret = req.headers['x-notify-secret'];
  if (secret !== process.env.NOTIFY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const year = now.getFullYear();
    const weekNum = getWeekNumber(now);
    const weekId = `${year}-W${String(weekNum).padStart(2, '0')}`;

    const promptDoc = await db.collection('weeklyPrompts').doc(weekId).get();
    const promptText = promptDoc.data()?.promptText;
    if (!promptText) {
      return res.status(404).json({ error: `No prompt found for ${weekId}` });
    }

    const usersSnap = await db.collection('users').where('fcmToken', '!=', '').get();
    if (usersSnap.empty) return res.json({ sent: 0, reason: 'No users with FCM tokens' });

    const tokens = usersSnap.docs.map(doc => doc.data().fcmToken).filter(Boolean);

    const chunks = [];
    for (let i = 0; i < tokens.length; i += 500) {
      chunks.push(tokens.slice(i, i + 500));
    }

    let totalSent = 0;
    for (const chunk of chunks) {
      const multicastMessage = {
        tokens: chunk,
        notification: {
          title: "This week's prompt is here",
          body: `"${promptText}"`
        },
        data: { type: 'weeklyPrompt', promptText },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } }
      };
      const response = await admin.messaging().sendEachForMulticast(multicastMessage);
      totalSent += response.successCount;
      console.log(`✅ Weekly prompt batch: ${response.successCount}/${chunk.length} sent`);
    }

    res.json({ sent: totalSent, weekId, promptText });
  } catch (err) {
    console.error('❌ Weekly prompt push failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Resonance proxy running on port ${PORT}`);
});
