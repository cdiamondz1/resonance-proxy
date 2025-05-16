const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

// Store token and expiration time
let token = null;
let tokenExpires = 0;

// Function to get a Spotify access token
async function getSpotifyToken() {
  if (token && Date.now() < tokenExpires) {
    return token;
  }

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({ grant_type: 'client_credentials' }),
    {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(
          process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
        ).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  token = response.data.access_token;
  tokenExpires = Date.now() + response.data.expires_in * 1000;
  return token;
}

// Add a test route for the homepage (optional)
app.get('/', (req, res) => {
  res.send('🎧 Spotify album search server is running!');
});

// Main /search route
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).send({ error: 'Missing query parameter' });
  }

  try {
    const accessToken = await getSpotifyToken();

    const response = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        q: query,
        type: 'album',
        limit: 10,
      },
    });

    const albums = response.data.albums.items.map(album => ({
      id: album.id,
      title: album.name,
      artist: album.artists[0].name,
      coverURL: album.images[0]?.url,
    }));

    res.send(albums);
  } catch (error) {
    console.error(error.message);
    res.status(500).send({ error: 'Spotify API error' });
  }
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
