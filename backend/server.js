import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import uploadRouter from './routes/upload.js';
import analyseRouter from './routes/analyse.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.use('/api/upload', uploadRouter);
app.use('/api/analyse', analyseRouter);

app.get('/', (req, res) => {
  res.json({ status: 'CV Analyser API is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});