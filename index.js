const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const anthropicConfig = require('./config/anthropic.json');
const redisConfig = require('./config/redis.json');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3001;
const BACKUP_FILE = path.join(__dirname, 'database', 'flashcards.json');

const anthropic = new Anthropic({
  apiKey: anthropicConfig.apiKey,
});

// Modify the Redis connection setup
let redis;
if (redisConfig.password) {
  redis = new Redis({
    host: redisConfig.host,
    port: redisConfig.port,
    password: redisConfig.password
  });
} else {
  redis = new Redis({
    host: redisConfig.host,
    port: redisConfig.port
  });
}

app.use(express.json());

// Simple queue implementation
const queue = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || queue.length === 0) return;
  
  isProcessing = true;
  const task = queue.shift();
  
  try {
    await task();
  } catch (error) {
    console.error('Error processing task:', error);
  }
  
  isProcessing = false;
  processQueue();
}

function addToQueue(task) {
  return new Promise((resolve, reject) => {
    queue.push(async () => {
      try {
        const result = await task();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    processQueue();
  });
}

// Modify the database structure
async function ensureRedisStructure() {
  const exists = await redis.exists('flashcards:decks');
  if (!exists) {
    await redis.sadd('flashcards:decks', 'initial');
    await redis.hmset('flashcards:initial', 'name', 'Initial Deck', 'notes', ' ');
    await redis.rpush('flashcards:initial:cards', JSON.stringify({
      id: Date.now().toString(),
      front: 'Sample front',
      back: 'Sample back',
      starred: false,
      learned: false,
    }));
  }
}

// Read database
async function readDatabase() {
  const deckIds = await redis.smembers('flashcards:decks');
  const decks = [];

  for (const deckId of deckIds) {
    const deckInfo = await redis.hgetall(`flashcards:${deckId}`);
    const cards = await redis.lrange(`flashcards:${deckId}:cards`, 0, -1);
    decks.push({
      id: deckId,
      name: deckInfo.name,
      notes: deckInfo.notes,
      flashcards: cards.map(JSON.parse),
    });
  }

  return { decks };
}

// Write database
async function writeDatabase(data) {
  // This function will now be used for backing up to JSON
  await fs.writeFile(BACKUP_FILE, JSON.stringify(data, null, 2));
}

// Backup function
async function backupToJson() {
  const data = await readDatabase();
  await writeDatabase(data);
  console.log('Backup completed');
}

// Schedule regular backups every 20 minutes
setInterval(backupToJson, 1000 * 60 * 20);

// Modify API endpoints to work with Redis

app.get('/api/decks', async (req, res) => {
  try {
    //console.log('Fetching decks...');
    const data = await addToQueue(readDatabase);
    //console.log('Fetched data:', data);
    
    if (!data || !data.decks) {
      console.error('Invalid data structure:', data);
      return res.status(500).json({ error: 'Invalid data structure' });
    }
    
    //console.log('Sending response:', data.decks);
    res.json(data.decks);
  } catch (error) {
    console.error('Failed to retrieve decks:', error);
    res.status(500).json({ error: 'Failed to retrieve decks', details: error.message });
  }
});

app.post('/api/decks', async (req, res) => {
  try {
    const newDeck = {
      id: Date.now().toString(),
      name: req.body.name,
      notes: '',
      flashcards: [],
    };
    
    await addToQueue(async () => {
      await redis.sadd('flashcards:decks', newDeck.id);
      await redis.hmset(`flashcards:${newDeck.id}`, 'name', newDeck.name, 'notes', newDeck.notes);
    });
    
    res.status(201).json(newDeck);
  } catch (error) {
    console.error('Failed to create deck:', error);
    res.status(500).json({ error: 'Failed to create deck', details: error.message });
  }
});

app.get('/api/decks/:id', async (req, res) => {
  try {
    const deckId = req.params.id;
    const deckInfo = await redis.hgetall(`flashcards:${deckId}`);
    if (deckInfo && deckInfo.name) {
      const cards = await redis.lrange(`flashcards:${deckId}:cards`, 0, -1);
      const deck = {
        id: deckId,
        name: deckInfo.name,
        notes: deckInfo.notes,
        flashcards: cards.map(JSON.parse),
      };
      res.json(deck);
    } else {
      res.status(404).json({ error: 'Deck not found' });
    }
  } catch (error) {
    console.error('Failed to retrieve deck:', error);
    res.status(500).json({ error: 'Failed to retrieve deck' });
  }
});

// Modify existing endpoints to work with decks
app.post('/api/decks/:id/flashcards', async (req, res) => {
  try {
    const newFlashcard = {
      id: Date.now().toString(),
      ...req.body,
      starred: false,
      learned: false,
    };
    
    await addToQueue(async () => {
      await redis.rpush(`flashcards:${req.params.id}:cards`, JSON.stringify(newFlashcard));
    });
    
    res.status(201).json(newFlashcard);
  } catch (error) {
    console.error('Failed to add flashcard:', error);
    res.status(500).json({ error: 'Failed to add flashcard' });
  }
});

// Update notes for a specific deck
app.put('/api/decks/:id/notes', async (req, res) => {
  try {
    const updatedDeck = await addToQueue(async () => {
      await redis.hset(`flashcards:${req.params.id}`, 'notes', req.body.notes);
      const deckInfo = await redis.hgetall(`flashcards:${req.params.id}`);
      const cards = await redis.lrange(`flashcards:${req.params.id}:cards`, 0, -1);
      return {
        id: req.params.id,
        name: deckInfo.name,
        notes: deckInfo.notes,
        flashcards: cards.map(JSON.parse),
      };
    });
    
    if (updatedDeck) {
      res.json(updatedDeck);
    } else {
      res.status(404).json({ error: 'Deck not found' });
    }
  } catch (error) {
    console.error('Failed to update notes:', error);
    res.status(500).json({ error: 'Failed to update notes' });
  }
});

// Modify the generate flashcards endpoint
app.post('/api/decks/:id/generate-flashcards', async (req, res) => {
  try {
    const { notes } = req.body;
    //console.log('Generating flashcards for notes:', notes);

    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 8192,
      system: "You are an expert flashcard creator. Your task is to generate comprehensive, high-quality flashcards from given notes. Focus on creating concise, clear questions and answers that cover all key concepts.",
      messages: [
        {
          role: "user",
          content: `
Create flashcards from the following notes. Generate as many cards as necessary to cover all important information. Each flashcard should have a 'front' (question) and 'back' (answer). 

Instructions:
1. Analyze the notes thoroughly.
2. Identify all key concepts, definitions, and important details.
3. Create a flashcard for each distinct piece of information.
4. Ensure questions are clear and specific.
5. Keep answers concise but complete.
6. Use a variety of question types (e.g., definition, explanation, comparison).
7. Avoid redundancy between cards.
8. Format your response as a JSON array of flashcard objects.

<output_format>
<example_format>
[
  {
    "front": "What is the capital of France?",
    "back": "Paris"
  },
  {
    "front": "List the three states of matter.",
    "back": "Solid, liquid, and gas"
  }
]
</example_format>

Your response must be a valid JSON array of flashcard objects, without any additional text or explanation. Each object should have 'front' and 'back' properties.
</output_format>

Notes: ${notes}`
        }
      ]
    });

    //console.log('Anthropic API response:', response);

    let generatedFlashcards;
    try {
      generatedFlashcards = JSON.parse(response.content[0].text);
      //console.log('Parsed flashcards:', generatedFlashcards);
    } catch (parseError) {
      console.error('Error parsing Anthropic response:', parseError);
      console.log('Raw response content:', response.content[0].text);
      throw new Error('Failed to parse generated flashcards');
    }

    if (!Array.isArray(generatedFlashcards)) {
      throw new Error('Generated flashcards is not an array');
    }

    const newFlashcards = generatedFlashcards.map(card => ({
      id: Date.now().toString() + Math.random().toString(36).slice(2, 11),
      ...card,
      starred: false,
      learned: false,
    }));

    await addToQueue(async () => {
      await redis.del(`flashcards:${req.params.id}:cards`);
      await redis.rpush(`flashcards:${req.params.id}:cards`, ...newFlashcards.map(JSON.stringify));
    });
    
    //console.log('Sending response with new flashcards:', newFlashcards);
    res.status(201).json(newFlashcards);
  } catch (error) {
    console.error('Failed to generate flashcards:', error);
    res.status(500).json({ error: 'Failed to generate flashcards', details: error.message });
  }
});

// Update a flashcard
app.put('/api/decks/:deckId/flashcards/:flashcardId', async (req, res) => {
  try {
    const updatedFlashcard = await addToQueue(async () => {
      const cards = await redis.lrange(`flashcards:${req.params.deckId}:cards`, 0, -1);
      const cardIndex = cards.findIndex(card => JSON.parse(card).id === req.params.flashcardId);
      if (cardIndex !== -1) {
        const updatedCard = { ...JSON.parse(cards[cardIndex]), ...req.body };
        await redis.lset(`flashcards:${req.params.deckId}:cards`, cardIndex, JSON.stringify(updatedCard));
        return updatedCard;
      }
      return null;
    });
    
    if (updatedFlashcard) {
      res.json(updatedFlashcard);
    } else {
      res.status(404).json({ error: 'Flashcard or deck not found' });
    }
  } catch (error) {
    console.error('Failed to update flashcard:', error);
    res.status(500).json({ error: 'Failed to update flashcard' });
  }
});

// Delete a flashcard
app.delete('/api/decks/:deckId/flashcards/:flashcardId', async (req, res) => {
  try {
    const result = await addToQueue(async () => {
      const cards = await redis.lrange(`flashcards:${req.params.deckId}:cards`, 0, -1);
      const updatedCards = cards.filter(card => JSON.parse(card).id !== req.params.flashcardId);
      if (cards.length !== updatedCards.length) {
        await redis.del(`flashcards:${req.params.deckId}:cards`);
        if (updatedCards.length > 0) {
          await redis.rpush(`flashcards:${req.params.deckId}:cards`, ...updatedCards);
        }
        return true;
      }
      return false;
    });
    
    if (result) {
      res.status(204).send();
    } else {
      res.status(404).json({ error: 'Flashcard or deck not found' });
    }
  } catch (error) {
    console.error('Failed to delete flashcard:', error);
    res.status(500).json({ error: 'Failed to delete flashcard' });
  }
});

// Modify the existing add flashcard endpoint
app.post('/api/decks/:id/flashcards', async (req, res) => {
  try {
    const newFlashcard = {
      id: Date.now().toString(),
      ...req.body,
      starred: false,
      learned: false,
    };
    
    const addedFlashcard = await addToQueue(async () => {
      await redis.rpush(`flashcards:${req.params.id}:cards`, JSON.stringify(newFlashcard));
      return newFlashcard;
    });
    
    if (addedFlashcard) {
      res.status(201).json(addedFlashcard);
    } else {
      res.status(404).json({ error: 'Deck not found' });
    }
  } catch (error) {
    console.error('Failed to add flashcard:', error);
    res.status(500).json({ error: 'Failed to add flashcard' });
  }
});

// Modify the PUT /api/decks/:id endpoint to update notes and name
app.put('/api/decks/:id', async (req, res) => {
  try {
    const updatedDeck = await addToQueue(async () => {
      const deckInfo = await redis.hgetall(`flashcards:${req.params.id}`);
      if (!deckInfo.name) {
        return null; // Deck not found
      }

      // Update only the fields that are provided in the request
      if (req.body.name) {
        await redis.hset(`flashcards:${req.params.id}`, 'name', req.body.name);
      }
      if (req.body.notes !== undefined) {
        await redis.hset(`flashcards:${req.params.id}`, 'notes', req.body.notes);
      }

      // Fetch the updated deck info
      const updatedDeckInfo = await redis.hgetall(`flashcards:${req.params.id}`);
      const cards = await redis.lrange(`flashcards:${req.params.id}:cards`, 0, -1);
      return {
        id: req.params.id,
        name: updatedDeckInfo.name,
        notes: updatedDeckInfo.notes,
        flashcards: cards.map(JSON.parse),
      };
    });
    
    if (updatedDeck) {
      res.json(updatedDeck);
    } else {
      res.status(404).json({ error: 'Deck not found' });
    }
  } catch (error) {
    console.error('Failed to update deck:', error);
    res.status(500).json({ error: 'Failed to update deck' });
  }
});

// Add this new endpoint for deleting a deck
app.delete('/api/decks/:id', async (req, res) => {
  try {
    const result = await addToQueue(async () => {
      const exists = await redis.sismember('flashcards:decks', req.params.id);
      if (exists) {
        await redis.srem('flashcards:decks', req.params.id);
        await redis.del(`flashcards:${req.params.id}`);
        await redis.del(`flashcards:${req.params.id}:cards`);
        return true;
      }
      return false;
    });
    
    if (result) {
      res.status(204).send();
    } else {
      res.status(404).json({ error: 'Deck not found' });
    }
  } catch (error) {
    console.error('Failed to delete deck:', error);
    res.status(500).json({ error: 'Failed to delete deck' });
  }
});

// Start the server
async function startServer() {
  await ensureRedisStructure();
  
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

startServer();