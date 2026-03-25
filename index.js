const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let access_token = '';

// MARK: - Token Management
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

// MARK: - Mood Definitions
// Seed artist IDs + audio feature targets per mood
const MOODS = {
  'late night': {
    seedArtists: [
      '2TI7qyDE0QfyOlnbtfDo7L', // The National
      '4ZGK4hkNX6pilAGnJbGBRf', // Bon Iver
      '4MXUO7sVCaFgFjoTI5ox5c', // Sufjan Stevens
    ],
    features: { target_energy: 0.25, target_valence: 0.25, target_acousticness: 0.75, target_tempo: 80 }
  },
  'heartbreak': {
    seedArtists: [
      '1r1uxoy19fzMxunt3ONAkG', // Phoebe Bridgers
      '2h93pZq0e7k5yf4dywlkpM', // Frank Ocean
      '00FQb4jTyendYWaN8pK0wa', // Lana Del Rey
    ],
    features: { target_energy: 0.35, target_valence: 0.2, target_acousticness: 0.6, target_tempo: 90 }
  },
  'feel good': {
    seedArtists: [
      '0bo0OinDHHBiU9GpjHn3rM', // Stevie Wonder (corrected)
      '4tZwfgrHOc3mvqYlEYSvVi', // Daft Punk
      '3fMbdgg4jU18AjLCKBhRSm', // Michael Jackson
    ],
    features: { target_energy: 0.8, target_valence: 0.9, target_danceability: 0.75, target_tempo: 115 }
  },
  'driving': {
    seedArtists: [
      '7Ln80lUS6He07XvHI8qqHH', // Arctic Monkeys
      '0epOFNiUfyOchXa0Y3KVEK', // The Strokes
      '004gAQE0aEFGMXPHDpRKOv', // QOTSA
    ],
    features: { target_energy: 0.85, target_valence: 0.6, target_danceability: 0.6, target_tempo: 130 }
  },
  'focus': {
    seedArtists: [
      '0kbYTNQb4Pb1rPbbaF0pT4', // Miles Davis
      '4YRxDV8wJFPHPTeXepOstw', // John Coltrane
      '7bkg0RXqKFoSJF8KBM2oFN', // Bill Evans
    ],
    features: { target_energy: 0.3, target_valence: 0.4, target_acousticness: 0.7, target_instrumentalness: 0.7, target_tempo: 95 }
  },
  'summer': {
    seedArtists: [
      '5VM9TypKaZERaBf9ex28A4', // Vampire Weekend (corrected)
      '3AA28KZvwAUcZuOKwyblJQ', // The Beach Boys
      '5INjqkS1o8h1imAzPqGZng', // Tame Impala
    ],
    features: { target_energy: 0.7, target_valence: 0.8, target_danceability: 0.65, target_tempo: 110 }
  }
};

// MARK: - Helper: get unique albums from track recommendations
async function getAlbumsFromRecommendations(seedArtists, features, limit = 10) {
  const params = {
    seed_artists: seedArtists.join(','),
    limit: 20,
    ...features
  };

  const recResponse = await axios.get('https://api.spotify.com/v1/recommendations', {
    headers: { Authorization: `Bearer ${access_token}` },
    params
  });

  const tracks = recResponse.data.tracks;

  // Deduplicate by album ID
  const seenAlbumIds = new Set();
  const uniqueAlbums = [];

  for (const track of tracks) {
    const album = track.album;
    if (!seenAlbumIds.has(album.id)) {
      seenAlbumIds.add(album.id);
      uniqueAlbums.push({
        id: album.id,
        name: album.name,
        artists: album.artists,
        images: album.images,
        release_date: album.release_date
      });
    }
    if (uniqueAlbums.length >= limit) break;
  }

  return uniqueAlbums;
}

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

// MARK: - Mood Recommendations
app.get('/recommendations', async (req, res) => {
  const { mood } = req.query;
  if (!mood) return res.status(400).json({ error: 'Missing mood parameter' });

  const moodKey = mood.toLowerCase();
  const moodConfig = MOODS[moodKey];

  if (!moodConfig) {
    return res.status(400).json({ error: `Unknown mood: ${mood}. Available: ${Object.keys(MOODS).join(', ')}` });
  }

  try {
    const albums = await getAlbumsFromRecommendations(
      moodConfig.seedArtists,
      moodConfig.features
    );
    res.json(albums);
  } catch (error) {
    console.error('❌ Recommendations failed:', error.response?.data || error.message);
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
