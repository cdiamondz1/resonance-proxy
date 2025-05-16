const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/search', async (req, res) => {
  const query = req.query.q;
  try {
    const result = await axios.get(`https://api.spotify.com/v1/search`, {
      headers: {
        Authorization: `Bearer ${process.env.SPOTIFY_TOKEN}`
      },
      params: {
        q: query,
        type: 'album'
      }
    });
    res.json(result.data);
  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});