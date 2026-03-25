const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let access_token = '';

async function refreshToken() {
  const { CLIENT_ID, CLIENT_SECRET } = process.env;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ Missing CLIENT_ID or CLIENT_SECRET in .env');
    return;
  }
  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'client_credentials' }),
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    access_token = response.data.access_token;
    console.log('✅ Spotify token refreshed');
  } catch (error) {
    console.error('❌ Failed to refresh token:', error.response?.data || error.message);
  }
}

refreshToken();
setInterval(refreshToken, 50 * 60 * 1000);

// MARK: - Keep-alive
setInterval(() => {
  https.get('https://resonance-proxy.onrender.com', (res) => {
    console.log('🏓 Keep-alive ping:', res.statusCode);
  }).on('error', (err) => {
    console.log('🏓 Keep-alive error:', err.message);
  });
}, 14 * 60 * 1000);

// MARK: - Root
app.get('/', (req, res) => {
  res.send('🎵 Spotify proxy is live');
});

// MARK: - Debug token
app.get('/test-token', async (req, res) => {
  const { CLIENT_ID, CLIENT_SECRET } = process.env;
  if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).send('Missing credentials');
  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'client_credentials' }),
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    res.send(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// MARK: - Search
app.get('/search', async (req, res) => {
  const { q, type = 'album' } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing search query' });

  try {
    const result = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${access_token}` },
      params: { q, type }
    });

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

// MARK: - Artist Info
app.get('/artist-info', async (req, res) => {
  const id = req.query.id;
  try {
    const result = await axios.get(`https://api.spotify.com/v1/artists/${id}`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    res.json(result.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// MARK: - Artist Albums
app.get('/artist-albums', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing artist ID' });

  try {
    const result = await axios.get(`https://api.spotify.com/v1/artists/${id}/albums`, {
      headers: { Authorization: `Bearer ${access_token}` },
      params: { include_groups: 'album', limit: 50 }
    });
    res.json(result.data.items);
  } catch (error) {
    console.error('❌ Artist albums fetch failed:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch albums' });
  }
});

// MARK: - Album Tracks
app.get('/album-tracks', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing album ID' });

  try {
    const result = await axios.get(`https://api.spotify.com/v1/albums/${id}/tracks`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    res.json(result.data.items);
  } catch (error) {
    console.error('❌ Album tracks fetch failed:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

// MARK: - Album Details
app.get('/album-details', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing album ID' });

  try {
    const result = await axios.get(`https://api.spotify.com/v1/albums/${id}`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    res.json(result.data);
  } catch (error) {
    console.error('❌ Album details fetch failed:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch album details' });
  }
});

// MARK: - Full Album
app.get('/full-album', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing album ID' });

  try {
    const result = await axios.get(`https://api.spotify.com/v1/albums/${id}`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    res.json(result.data);
  } catch (error) {
    console.error('❌ Full album fetch failed:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch full album data' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Spotify proxy running on port ${PORT}`);
});
